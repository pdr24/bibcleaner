import type { CandidateScore, Confidence, VerificationState, Work } from '../models/types';
import { THRESHOLDS, WEIGHTS, YEAR_SCORES } from './config';
import { correctionMarker, titleSimilarity, tokenSimilarity, tokens } from '../normalize/text';
import { compareAuthorLists } from '../normalize/authors';
import { venueSimilarity } from '../normalize/venue';
import { sameDoi } from '../normalize/doi';

export function confidenceFor(total: number): Confidence {
  if (total >= THRESHOLDS.veryHigh) return 'VERY HIGH';
  if (total >= THRESHOLDS.high) return 'HIGH';
  if (total >= THRESHOLDS.possible) return 'POSSIBLE';
  return 'LOW';
}

export function yearScore(a?: number, b?: number): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  const d = Math.abs(a - b);
  return d === 0 ? YEAR_SCORES.exact : d === 1 ? YEAR_SCORES.offByOne : YEAR_SCORES.other;
}

export interface ScoreOptions {
  /** The input and candidate are known to be preprint/published versions of one paper. */
  versionComparison?: boolean;
  inputAuthorsTruncated?: boolean;
}

/**
 * Deterministic candidate score. Components with no data on either side are
 * excluded and the remaining weights renormalised, so a sparse citation is
 * not penalised for fields it never had — but the component list shows what
 * was actually compared.
 */
export function scoreCandidate(input: Work, cand: Work, opts: ScoreOptions = {}): CandidateScore {
  const components: CandidateScore['components'] = {};
  const critical: string[] = [];
  let weighted = 0;
  let weightSum = 0;
  const add = (k: keyof typeof WEIGHTS, v: number | undefined) => {
    if (v === undefined) return;
    components[k] = v;
    weighted += WEIGHTS[k] * v;
    weightSum += WEIGHTS[k];
  };

  const tSim = input.title && cand.title ? titleSimilarity(input.title, cand.title) : undefined;
  add('title', tSim);

  let authorCmp;
  if (input.authors.length && cand.authors.length) {
    authorCmp = compareAuthorLists(input.authors, cand.authors, opts.inputAuthorsTruncated);
    add('authors', authorCmp.score);
  }
  if (input.venue && cand.venue) add('venue', venueSimilarity(input.venue, cand.venue, input.venueShort, cand.venueShort));
  add('year', yearScore(input.year, cand.year));
  if (input.publisher && cand.publisher) add('publisher', tokenSimilarity(tokens(input.publisher), tokens(cand.publisher)));

  let total = weightSum > 0 ? weighted / weightSum : 0;
  // A citation with only a title can never be better than POSSIBLE on text alone.
  const compared = Object.keys(components).length;
  if (compared <= 1) total = Math.min(total, THRESHOLDS.possible + 0.05);

  const identifierMatch =
    !!(input.doi && cand.doi && sameDoi(input.doi, cand.doi)) ||
    !!(input.arxivId && cand.arxivId && input.arxivId.replace(/v\d+$/, '') === cand.arxivId.replace(/v\d+$/, ''));
  if (identifierMatch) components.identifier = 1;

  // ---- Critical contradictions (block VERIFIED regardless of score) ----
  if (tSim !== undefined && tSim < THRESHOLDS.doiTitleConflict && identifierMatch)
    critical.push('The DOI belongs to a work with a different title.');
  else if (tSim !== undefined && tSim < 0.75) critical.push('Titles differ substantially.');
  if (authorCmp) {
    if (!authorCmp.firstAuthorMatch && authorCmp.overlap < THRESHOLDS.authorOverlapCritical) critical.push('Author lists do not match.');
    else if (authorCmp.overlap < THRESHOLDS.authorOverlapCritical) critical.push('Most authors differ.');
    else if (!authorCmp.firstAuthorMatch) critical.push('First author differs.');
  }
  // An erratum / comment / retraction notice repeats the title of the work it
  // refers to. Matching one to the other would assign the wrong DOI.
  const inMark = correctionMarker(input.title);
  const candMark = correctionMarker(cand.title);
  if (!!inMark !== !!candMark && tSim !== undefined && tSim >= 0.6) {
    const article = (w: string) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
    critical.push(
      candMark
        ? `The record is ${article(candMark)} ${candMark} notice about this work, not the work itself.`
        : `Your citation is ${article(inMark!)} ${inMark} notice; the record is the work it refers to.`,
    );
  }
  if (input.year !== undefined && cand.year !== undefined && Math.abs(input.year - cand.year) > 1 && !opts.versionComparison)
    critical.push(`Publication years differ by ${Math.abs(input.year - cand.year)} years.`);
  if (
    input.venue &&
    cand.venue &&
    input.year !== undefined &&
    cand.year !== undefined &&
    input.year !== cand.year &&
    venueSimilarity(input.venue, cand.venue, input.venueShort, cand.venueShort) < 0.4 &&
    !opts.versionComparison
  )
    critical.push('Different venue and year: this may be another version of the paper.');

  // Identifier evidence can supersede the weighted score when metadata is consistent.
  if (identifierMatch && critical.length === 0 && (tSim === undefined || tSim >= 0.85)) total = Math.max(total, 0.97);

  const confidence = confidenceFor(total);
  let state: VerificationState;
  if (identifierMatch && critical.some((c) => c.startsWith('The DOI belongs'))) state = 'CONFLICT';
  else if (critical.length && total >= THRESHOLDS.possible) state = 'CONFLICT';
  else if (critical.length) state = 'UNVERIFIED';
  else if (confidence === 'VERY HIGH') state = 'VERIFIED';
  else if (confidence === 'HIGH') state = 'HIGH CONFIDENCE';
  else state = 'UNVERIFIED';

  return {
    total: Math.round(total * 1000) / 1000,
    components,
    identifierMatch,
    criticalContradictions: critical,
    confidence: critical.length ? downgrade(confidence) : confidence,
    state,
  };
}

function downgrade(c: Confidence): Confidence {
  return c === 'VERY HIGH' ? 'POSSIBLE' : c === 'HIGH' ? 'POSSIBLE' : c;
}

/** Are two records the same work (possibly different versions)? Used for grouping. */
export function sameWork(a: Work, b: Work): boolean {
  if (a.doi && b.doi && sameDoi(a.doi, b.doi)) return true;
  if (a.arxivId && b.arxivId && a.arxivId.replace(/v\d+$/, '') === b.arxivId.replace(/v\d+$/, '')) return true;
  if (!a.title || !b.title) return false;
  if (!!correctionMarker(a.title) !== !!correctionMarker(b.title)) return false;
  const t = titleSimilarity(a.title, b.title);
  if (t < THRESHOLDS.sameWorkTitle) return false;
  if (a.authors.length && b.authors.length) {
    const ac = compareAuthorLists(a.authors, b.authors);
    if (!ac.firstAuthorMatch || ac.overlap < 0.6) return false;
  }
  return true;
}

/** Same work AND same version (not preprint vs published). */
export function sameRecord(a: Work, b: Work): boolean {
  if (a.doi && b.doi) return sameDoi(a.doi, b.doi);
  if (!!a.isPreprint !== !!b.isPreprint) return false;
  if (!sameWork(a, b)) return false;
  if (a.year && b.year && Math.abs(a.year - b.year) > 1) return false;
  if (a.venue && b.venue && venueSimilarity(a.venue, b.venue, a.venueShort, b.venueShort) < 0.5) return false;
  return true;
}
