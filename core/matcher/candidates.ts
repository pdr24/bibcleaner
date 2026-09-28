import type { Candidate, SourceName, Work } from '../models/types';
import { sameRecord, sameWork, scoreCandidate } from '../confidence/score';
import { THRESHOLDS } from '../confidence/config';
import type { InputCitation } from '../verification/input';

/**
 * Source precedence (highest first). This is a decision aid for which value
 * to *propose*; conflicting values from other sources stay visible.
 * Publisher pages are not queried in V1, so the DOI registry is the top tier.
 */
export const PRECEDENCE: SourceName[] = ['Crossref', 'DataCite', 'DBLP', 'OpenAlex', 'arXiv'];

export function rank(w: Work): number {
  const s = w.sourceRecords[0]?.source;
  const i = PRECEDENCE.indexOf(s as SourceName);
  return i < 0 ? PRECEDENCE.length : i;
}

const MERGE_FIELDS: (keyof Work)[] = [
  'title',
  'year',
  'venue',
  'venueShort',
  'publisher',
  'volume',
  'issue',
  'pages',
  'doi',
  'url',
  'isbn',
  'issn',
  'arxivId',
  'type',
];

/** Merges records of the SAME record (same version) into one view, by precedence. */
export function mergeRecords(records: Work[]): Work {
  const sorted = [...records].sort((a, b) => rank(a) - rank(b));
  const out: Work = { authors: [], sourceRecords: [] };
  for (const r of sorted) {
    for (const k of MERGE_FIELDS) {
      if (out[k] === undefined && r[k] !== undefined && r[k] !== '' && !(Array.isArray(r[k]) && (r[k] as unknown[]).length === 0)) {
        (out as unknown as Record<string, unknown>)[k] = r[k];
      }
    }
    // Venue short labels come mostly from DBLP; keep them even if a higher source has a long venue.
    if (!out.venueShort && r.venueShort) out.venueShort = r.venueShort;
    if (!out.authors.length && r.authors.length) out.authors = r.authors;
    out.isPreprint = out.isPreprint ?? r.isPreprint;
    out.relatedDois = [...new Set([...(out.relatedDois ?? []), ...(r.relatedDois ?? [])])];
    out.sourceRecords.push(...r.sourceRecords);
  }
  out.isPreprint = sorted[0]?.isPreprint;
  return out;
}

export interface CandidateSet {
  candidates: Candidate[];
  /** Default candidate id, or null when ambiguous / nothing credible. */
  selectedId: string | null;
  ambiguous: boolean;
  /** Set when the best match has both a preprint and a published version. */
  versions?: { publishedId: string; preprintId: string };
  message?: string;
}

export function buildCandidates(input: InputCitation, records: Work[]): CandidateSet {
  // 1. Collapse records describing the same version of the same work.
  const groups: Work[][] = [];
  for (const r of records) {
    if (!r.title && !r.doi) continue;
    const g = groups.find((grp) => grp.some((x) => sameRecord(x, r)));
    if (g) {
      if (!g.some((x) => x.sourceRecords[0]?.source === r.sourceRecords[0]?.source && x.doi === r.doi && x.title === r.title)) g.push(r);
    } else groups.push([r]);
  }

  // 2. Score each merged candidate against the citation.
  let candidates: Candidate[] = groups.map((g, i) => {
    const work = mergeRecords(g);
    return {
      id: `c${i}`,
      work,
      records: [...g].sort((a, b) => rank(a) - rank(b)),
      score: scoreCandidate(input.work, work, { inputAuthorsTruncated: input.authorsTruncated }),
      versionGroup: '',
    };
  });

  // 3. Version groups: preprint and published forms of the same paper.
  let vg = 0;
  for (const c of candidates) {
    if (c.versionGroup) continue;
    c.versionGroup = `v${vg++}`;
    for (const d of candidates) if (!d.versionGroup && sameWork(c.work, d.work)) d.versionGroup = c.versionGroup;
  }
  // Re-score version siblings leniently for year/venue (a preprint year differing from the proceedings year is expected).
  const best0 = [...candidates].sort((a, b) => b.score.total - a.score.total)[0];
  if (best0) {
    for (const c of candidates) {
      if (c !== best0 && c.versionGroup === best0.versionGroup && !!c.work.isPreprint !== !!best0.work.isPreprint) {
        c.score = scoreCandidate(input.work, c.work, { versionComparison: true, inputAuthorsTruncated: input.authorsTruncated });
      }
    }
  }

  candidates = candidates.filter((c) => c.score.total >= THRESHOLDS.display || c.score.identifierMatch);
  candidates.sort((a, b) => b.score.total - a.score.total || rank(a.records[0]) - rank(b.records[0]));
  candidates.forEach((c, i) => (c.id = `c${i}`));

  const result: CandidateSet = { candidates, selectedId: null, ambiguous: false };
  if (!candidates.length) {
    result.message = 'No credible matching publication was found.';
    return result;
  }
  const best = candidates[0];
  if (best.score.total < THRESHOLDS.possible && !best.score.identifierMatch) {
    result.message = 'Only weak matches were found. Nothing was selected; review the candidates if any look right.';
    return result;
  }

  // 4. Ambiguity between DISTINCT works with comparable scores.
  const rival = candidates.find(
    (c) =>
      c.versionGroup !== best.versionGroup &&
      c.score.total >= THRESHOLDS.possible &&
      best.score.total - c.score.total < THRESHOLDS.ambiguityGap,
  );
  if (rival && !best.score.identifierMatch) {
    result.ambiguous = true;
    result.message = 'Several different publications match this citation about equally well. Choose the one you meant.';
    return result;
  }

  // 5. Prefer the published version as the default candidate (FR-11), but keep both visible.
  const siblings = candidates.filter((c) => c.versionGroup === best.versionGroup);
  const published = siblings.find((c) => !c.work.isPreprint && c.score.state !== 'CONFLICT' && c.score.total >= THRESHOLDS.possible);
  const preprint = siblings.find((c) => c.work.isPreprint);
  if (published && preprint) {
    result.versions = { publishedId: published.id, preprintId: preprint.id };
    result.selectedId = published.id;
  } else result.selectedId = best.id;
  return result;
}
