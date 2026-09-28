import { foldDiacritics, normalizeForComparison, tokenSimilarity } from './text';
import { latexToUnicode } from './latex';

const VENUE_NOISE = new Set([
  'proceedings',
  'proc',
  'of',
  'the',
  'in',
  'on',
  'and',
  'for',
  'annual',
  'international',
  'intl',
  'conference',
  'conf',
  'symposium',
  'symp',
  'workshop',
  'acm',
  'ieee',
  'usenix',
  'journal',
  'j',
  'transactions',
  'trans',
  'st',
  'nd',
  'rd',
  'th',
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'volume',
  'vol',
  'part',
]);

const ACRONYM_STOP = new Set([
  'ACM',
  'IEEE',
  'USENIX',
  'SIAM',
  'AAAI',
  'LNCS',
  'CEUR',
  'SIG',
  'PMLR',
  'II',
  'III',
  'IV',
  'NY',
  'USA',
  'UK',
]);

function coreTokens(v: string): string[] {
  return normalizeForComparison(v)
    .split(' ')
    .filter((t) => t && !VENUE_NOISE.has(t) && !/^\d+$/.test(t) && !/^\d+(st|nd|rd|th)$/.test(t));
}

/** Candidate acronyms appearing in a venue string: "(CCS '24)", "CHI", "SIGCSE TS". */
export function venueAcronyms(v: string | undefined): string[] {
  if (!v) return [];
  const text = foldDiacritics(latexToUnicode(v));
  const out: string[] = [];
  for (const m of text.matchAll(/\b([A-Z][A-Za-z]*[A-Z][A-Za-z0-9]*|[A-Z]{2,})\b/g)) {
    const a = m[1];
    if (a.length >= 2 && a.length <= 12 && !ACRONYM_STOP.has(a.toUpperCase())) out.push(a.toLowerCase());
  }
  return [...new Set(out)];
}

const INITIAL_NOISE = new Set(['of', 'the', 'on', 'for', 'and', 'in', 'a', 'at']);

/**
 * Initialisms a venue name can be abbreviated to: "Computer and Communications
 * Security" -> "ccs", "International Conference on Machine Learning" -> "icml".
 * Built both from all words and from the significant words only, because
 * sources abbreviate either way.
 */
export function venueInitialisms(v: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!v) return out;
  const all = normalizeForComparison(v)
    .split(' ')
    .filter((t) => t && !INITIAL_NOISE.has(t) && !/^\d/.test(t));
  const core = coreTokens(v);
  for (const list of [all, core]) {
    if (list.length >= 3 && list.length <= 8) out.add(list.map((t) => t[0]).join(''));
  }
  return out;
}

/**
 * Venue similarity in [0,1]. Venue strings differ wildly between sources
 * ("CHI" vs "Proceedings of the 2024 CHI Conference on Human Factors in
 * Computing Systems"), so an acronym containment counts as a strong match.
 */
export function venueSimilarity(a: string | undefined, b: string | undefined, aShort?: string, bShort?: string): number {
  if (!a || !b) return 0;
  const ta = coreTokens(a);
  const tb = coreTokens(b);
  const tokSim = tokenSimilarity(ta, tb);
  if (tokSim >= 0.999) return 1;
  const accA = new Set([...venueAcronyms(a), ...(aShort ? [aShort.toLowerCase()] : [])]);
  const accB = new Set([...venueAcronyms(b), ...(bShort ? [bShort.toLowerCase()] : [])]);
  const tokenSetA = new Set(ta);
  const tokenSetB = new Set(tb);
  let acronymHit = false;
  for (const x of accA) if (accB.has(x) || tokenSetB.has(x)) acronymHit = true;
  for (const x of accB) if (accA.has(x) || tokenSetA.has(x)) acronymHit = true;
  // An acronym on one side can be the initialism of the other side's words
  // ("CCS" vs "ACM Conference on Computer and Communications Security").
  const initA = venueInitialisms(a);
  const initB = venueInitialisms(b);
  const initialHit = (acc: Set<string>, init: Set<string>) => [...acc].some((x) => x.length >= 3 && init.has(x));
  if (initialHit(accA, initB) || initialHit(accB, initA)) acronymHit = true;
  // arXiv / CoRR are the same "venue".
  const isArx = (s: string) => /\b(arxiv|corr)\b/i.test(s);
  if (isArx(a) && isArx(b)) return 1;
  // One side is a subset of the other (abbreviated journal names etc.).
  const [small, big] = ta.length <= tb.length ? [ta, tokenSetB] : [tb, tokenSetA];
  const contained = small.length > 0 && small.every((t) => big.has(t) || [...big].some((x) => x.startsWith(t) && t.length >= 3));
  let score = tokSim;
  if (contained) score = Math.max(score, 0.85);
  if (acronymHit) score = Math.max(score, 0.9);
  return score;
}

export function isPreprintVenue(v: string | undefined): boolean {
  return !!v && /\b(arxiv|corr|biorxiv|medrxiv|ssrn|preprint|techrxiv|openreview)\b/i.test(v);
}

/** Short venue abbreviation for citation keys. */
export function venueAbbrev(venue: string | undefined, venueShort?: string): string | undefined {
  if (venueShort) return venueShort.toLowerCase().replace(/[^a-z0-9]/g, '') || undefined;
  if (!venue) return undefined;
  const paren = venue.match(/\(([A-Z][A-Za-z0-9-]{1,11})(?:\s*['’]?\s*\d{2,4})?\)/);
  if (paren) return paren[1].toLowerCase().replace(/[^a-z0-9]/g, '');
  const acr = venueAcronyms(venue);
  return acr[0]?.replace(/[^a-z0-9]/g, '') || undefined;
}
