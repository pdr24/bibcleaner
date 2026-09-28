/**
 * Scoring for the real-citation acceptance corpus (PRD §51). Pure functions so
 * the metric definitions themselves are unit tested.
 */
import type { Candidate, Suggestion } from '../../core/models/types';
import { parseDoi, sameDoi } from '../../core/normalize/doi';
import { normalizeForComparison } from '../../core/normalize/text';
import { latexToUnicode } from '../../core/normalize/latex';
import { pagesEquivalent } from '../../core/normalize/pages';
import { venueSimilarity } from '../../core/normalize/venue';

export interface Truth {
  /** Manually verified DOI; null means "verified to have no DOI". Omit if unknown. */
  doi?: string | null;
  title?: string;
  year?: number;
  venue?: string;
  pages?: string;
  /** true when several distinct works plausibly match the input as written. */
  ambiguous?: boolean;
}

export interface LiveEntry {
  id: string;
  category?: string;
  bib: string;
  truth: Truth;
  notes?: string;
  _template?: boolean;
}

export type Verdict = 'correct' | 'incorrect' | 'unjudged';

const VENUE_FIELDS = new Set(['journal', 'booktitle']);
const METADATA = new Set(['conflict', 'missing', 'version', 'url']);

/** Judges one suggested value against the verified truth. */
export function judge(s: Suggestion, t: Truth): Verdict {
  if (!METADATA.has(s.category) || s.patch.kind !== 'set') return 'unjudged';
  const v = s.suggestedValue;
  const f = s.field.toLowerCase();
  if (f === 'doi') {
    if (t.doi === undefined) return 'unjudged';
    if (t.doi === null) return 'incorrect';
    return sameDoi(parseDoi(v)?.doi ?? v, t.doi) ? 'correct' : 'incorrect';
  }
  if (f === 'year' && t.year !== undefined) return Number(v) === t.year ? 'correct' : 'incorrect';
  if (f === 'title' && t.title)
    return normalizeForComparison(latexToUnicode(v)) === normalizeForComparison(t.title) ? 'correct' : 'incorrect';
  if (f === 'pages' && t.pages) return pagesEquivalent(v, t.pages) ? 'correct' : 'incorrect';
  if (VENUE_FIELDS.has(f) && t.venue) return venueSimilarity(latexToUnicode(v), t.venue) >= 0.85 ? 'correct' : 'incorrect';
  return 'unjudged';
}

export function top1Correct(c: Candidate | null, t: Truth): boolean | undefined {
  if (t.ambiguous) return undefined;
  if (!c) return t.doi === undefined && !t.title ? undefined : false;
  if (t.doi) return !!c.work.doi && sameDoi(c.work.doi, t.doi);
  if (t.title)
    return (
      normalizeForComparison(c.work.title ?? '') === normalizeForComparison(t.title) && (t.year === undefined || c.work.year === t.year)
    );
  return undefined;
}

export interface EntryOutcome {
  id: string;
  inputHadDoi: boolean;
  truth: Truth;
  ambiguousPredicted: boolean;
  top1?: boolean;
  score?: number;
  judged: { s: Suggestion; verdict: Verdict }[];
  error?: string;
}

const pctOf = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const isHigh = (s: Suggestion) => s.confidence === 'HIGH' || s.confidence === 'VERY HIGH';

export interface Report {
  lines: string[];
  highConfidenceIncorrect: { id: string; field: string; value: string }[];
}

export function report(out: EntryOutcome[]): Report {
  const lines: string[] = [];
  const ok = out.filter((o) => !o.error);
  lines.push(`Entries evaluated: ${ok.length} (${out.length - ok.length} errored)`);

  // DOI discovery (entries whose input had no DOI)
  const noDoi = ok.filter((o) => !o.inputHadDoi);
  const doiSug = noDoi.flatMap((o) =>
    o.judged.filter((j) => j.s.field.toLowerCase() === 'doi' && j.verdict !== 'unjudged').map((j) => ({ o, j })),
  );
  const doiCorrect = doiSug.filter((x) => x.j.verdict === 'correct').length;
  const shouldFind = noDoi.filter((o) => typeof o.truth.doi === 'string');
  const found = shouldFind.filter((o) => o.judged.some((j) => j.s.field.toLowerCase() === 'doi' && j.verdict === 'correct')).length;
  lines.push(`DOI discovery precision: ${pctOf(doiCorrect, doiSug.length)} (${doiCorrect}/${doiSug.length})`);
  lines.push(`DOI discovery recall:    ${pctOf(found, shouldFind.length)} (${found}/${shouldFind.length})`);
  const allDoi = ok.flatMap((o) => o.judged.filter((j) => j.s.field.toLowerCase() === 'doi' && j.verdict !== 'unjudged'));
  lines.push(`Incorrect DOI rate:      ${pctOf(allDoi.filter((j) => j.verdict === 'incorrect').length, allDoi.length)}`);

  const judged = ok.flatMap((o) => o.judged.filter((j) => j.verdict !== 'unjudged'));
  lines.push(
    `Field correction precision: ${pctOf(judged.filter((j) => j.verdict === 'correct').length, judged.length)} (${judged.length} judged suggestions)`,
  );

  const t1 = ok.filter((o) => o.top1 !== undefined);
  lines.push(`Candidate top-1 accuracy:   ${pctOf(t1.filter((o) => o.top1).length, t1.length)} (${t1.length} entries)`);

  const amb = ok.filter((o) => o.truth.ambiguous !== undefined);
  const ambRight = amb.filter((o) => !!o.truth.ambiguous === o.ambiguousPredicted).length;
  lines.push(`Ambiguity detection accuracy: ${pctOf(ambRight, amb.length)} (${amb.length} labelled)`);

  const hi = ok.flatMap((o) => o.judged.filter((j) => j.verdict !== 'unjudged' && isHigh(j.s)).map((j) => ({ o, j })));
  const hiBad = hi.filter((x) => x.j.verdict === 'incorrect');
  lines.push('');
  lines.push(
    `INCORRECT HIGH-CONFIDENCE CORRECTION RATE: ${pctOf(hiBad.length, hi.length)} (${hiBad.length}/${hi.length})  target: effectively 0`,
  );

  // Calibration table: how often the selected candidate is right above each score.
  const scored = ok.filter((o) => o.top1 !== undefined && o.score !== undefined);
  if (scored.length) {
    lines.push('');
    lines.push('Calibration (selected candidate): threshold, entries at or above, top-1 precision');
    for (const th of [0.7, 0.8, 0.85, 0.9, 0.95, 0.97]) {
      const above = scored.filter((o) => o.score! >= th);
      lines.push(`  ${th.toFixed(2)}  ${String(above.length).padStart(4)}  ${pctOf(above.filter((o) => o.top1).length, above.length)}`);
    }
  }
  return { lines, highConfidenceIncorrect: hiBad.map((x) => ({ id: x.o.id, field: x.j.s.field, value: x.j.s.suggestedValue })) };
}
