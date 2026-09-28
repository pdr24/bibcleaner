import { latexToUnicode } from './latex';

/** Removes diacritics after Unicode decomposition ("Müller" -> "Muller"). */
export function foldDiacritics(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[øØ]/g, 'o')
    .replace(/[łŁ]/g, 'l')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[œŒ]/g, 'oe')
    .replace(/ı/g, 'i');
}

/**
 * Comparison form of a title (or any free text). Never displayed or written back.
 * lowercase, Unicode-normalised, LaTeX decoded, non-semantic braces removed,
 * dash variants unified, punctuation removed, whitespace collapsed.
 */
export function normalizeForComparison(s: string | undefined): string {
  if (!s) return '';
  let t = latexToUnicode(s);
  t = foldDiacritics(t).toLowerCase();
  t = t.replace(/[\u2010-\u2015\u2212-]/g, ' ');
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

export function tokens(s: string | undefined): string[] {
  const n = normalizeForComparison(s);
  return n ? n.split(' ') : [];
}

export const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'for',
  'and',
  'or',
  'in',
  'on',
  'at',
  'to',
  'with',
  'by',
  'from',
  'via',
  'into',
  'towards',
  'toward',
  'using',
  'based',
  'is',
  'are',
  'its',
  'as',
  'we',
  'our',
  'how',
  'what',
  'why',
  'when',
  'do',
  'does',
  'can',
  'new',
  'vs',
]);

/** Levenshtein distance with O(min(a,b)) memory and an early cap for very long strings. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length > 2000 || b.length > 2000) {
    a = a.slice(0, 2000);
    b = b.slice(0, 2000);
  }
  if (a.length < b.length) [a, b] = [b, a];
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

export function editSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/** Dice coefficient over token multisets. */
export function tokenSimilarity(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of b) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      common++;
      counts.set(t, c - 1);
    }
  }
  return (2 * common) / (a.length + b.length);
}

/**
 * Title similarity: token overlap blended with character edit similarity.
 * A subtitle present on only one side is tolerated a little (prefix match).
 */
export function titleSimilarity(a: string | undefined, b: string | undefined): number {
  const na = normalizeForComparison(a);
  const nb = normalizeForComparison(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const tok = tokenSimilarity(na.split(' '), nb.split(' '));
  const edit = editSimilarity(na, nb);
  let score = 0.6 * tok + 0.4 * edit;
  // "Title" vs "Title: A Subtitle" — main title identical.
  const [short, long] = na.length < nb.length ? [na, nb] : [nb, na];
  if (short.length >= 20 && long.startsWith(short)) score = Math.max(score, 0.9);
  return Math.max(0, Math.min(1, score));
}

/**
 * Editorial notices ("Erratum: X", "Retraction of X", "Comment on X") carry the
 * title of the work they refer to, so they score as near-identical to that
 * work. They are separate documents with their own DOI, and confusing one for
 * the other is exactly the kind of confident wrong correction BibCleaner must
 * not make. Returns the notice word when a title is one of these.
 */
const CORRECTION_MARKER =
  /^\s*(erratum|errata|corrigendum|correction|retraction|retracted|addendum|withdrawal|withdrawn|comment|comments|commentary|reply|response|rejoinder|discussion|editorial|preface|foreword|author correction|publisher correction|expression of concern)\b\s*(to|on|of|for|:|\u2014|\u2013|-)/i;

export function correctionMarker(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const plain = title.replace(/[{}]/g, '').trim();
  const m = CORRECTION_MARKER.exec(plain);
  return m ? m[1].toLowerCase() : undefined;
}
