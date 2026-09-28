/**
 * All scoring weights and thresholds live here so they can be calibrated
 * against the golden corpus without touching matching code.
 * These are INITIAL values from the PRD and MUST be calibrated before release.
 */
export const WEIGHTS = {
  title: 0.35,
  authors: 0.3,
  venue: 0.15,
  year: 0.1,
  publisher: 0.1,
} as const;

export const THRESHOLDS = {
  veryHigh: 0.95,
  high: 0.85,
  possible: 0.7,
  /** Two distinct works within this score gap are considered ambiguous. */
  ambiguityGap: 0.06,
  /** Candidates below this are not shown at all. */
  display: 0.45,
  /** Minimum title similarity for two records to be treated as the same work. */
  sameWorkTitle: 0.9,
  /** Title similarity below which an exact DOI match is a CONFLICT (DOI belongs to another work). */
  doiTitleConflict: 0.6,
  /** Author overlap below which the author lists are a critical discrepancy. */
  authorOverlapCritical: 0.5,
} as const;

export const YEAR_SCORES = { exact: 1, offByOne: 0.6, other: 0 } as const;
