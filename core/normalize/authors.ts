import type { Author } from '../models/types';
import { latexToUnicode, unicodeToLatex } from './latex';
import { editSimilarity, foldDiacritics } from './text';

/** Splits on a keyword (" and ") only at brace depth 0. */
function splitTopLevel(s: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (depth === 0) {
      sep.lastIndex = i;
      const m = sep.exec(s);
      if (m && m.index === i) {
        out.push(cur);
        cur = '';
        i += m[0].length;
        continue;
      }
    }
    cur += c;
    i++;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

function splitCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function splitWords(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (/\s|~/.test(c) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const isLowerWord = (w: string) => {
  const plain = latexToUnicode(w);
  return plain.length > 0 && plain[0] === plain[0].toLowerCase() && plain[0] !== plain[0].toUpperCase();
};

export interface ParsedAuthorList {
  authors: Author[];
  /** "and others" / "et al." present. */
  truncated: boolean;
}

/** Parses one BibTeX name into structured form (values stay LaTeX-encoded). */
export function parseName(raw: string): Author {
  const name = raw.trim();
  if (/^\{.*\}$/s.test(name) && !name.slice(1, -1).includes('{')) {
    return { family: name.slice(1, -1), given: '', literal: name.slice(1, -1) };
  }
  const parts = splitCommas(name);
  if (parts.length >= 3) return { family: parts[0], given: parts.slice(2).join(' ') };
  if (parts.length === 2) return { family: parts[0], given: parts[1] };
  const words = splitWords(name);
  if (words.length === 1) return { family: words[0], given: '' };
  // "First von Last": family starts at the first lowercase particle, else last word.
  let k = words.findIndex((w, idx) => idx > 0 && idx < words.length - 1 && isLowerWord(w));
  if (k < 0) k = words.length - 1;
  return { family: words.slice(k).join(' '), given: words.slice(0, k).join(' ') };
}

export function parseAuthorField(value: string | undefined): ParsedAuthorList {
  if (!value) return { authors: [], truncated: false };
  const names = splitTopLevel(value.replace(/\s+/g, ' '), /\s+and\s+/iy);
  let truncated = false;
  const authors: Author[] = [];
  for (const n of names) {
    if (/^(others|et\.?\s*al\.?)$/i.test(n.trim())) {
      truncated = true;
      continue;
    }
    authors.push(parseName(n));
  }
  return { authors, truncated };
}

function cmpKey(s: string): string {
  return foldDiacritics(latexToUnicode(s))
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

function initials(given: string): string[] {
  return foldDiacritics(latexToUnicode(given))
    .split(/[\s.\-]+/)
    .filter(Boolean)
    .map((w) => w[0].toLowerCase());
}

function givenFull(given: string): string[] {
  return foldDiacritics(latexToUnicode(given))
    .toLowerCase()
    .split(/[\s.\-]+/)
    .filter((w) => w.length > 1);
}

/** Pairwise similarity of two authors in [0,1]. */
export function authorPairSimilarity(a: Author, b: Author): number {
  if (a.literal || b.literal) {
    return editSimilarity(cmpKey(a.literal ?? a.family + a.given), cmpKey(b.literal ?? b.family + b.given)) >= 0.9 ? 1 : 0;
  }
  const fa = cmpKey(a.family);
  const fb = cmpKey(b.family);
  // Particles ("van der") may be attached differently across sources.
  const lastWord = (s: string) => cmpKey(latexToUnicode(s).split(/\s+/).pop() ?? '');
  const familyEq =
    fa === fb || lastWord(a.family) === lastWord(b.family) || (fa.length > 3 && fb.length > 3 && (fa.endsWith(fb) || fb.endsWith(fa)));
  if (!familyEq) {
    // Given/family swapped (common for East-Asian names across sources).
    if (cmpKey(a.family) === cmpKey(b.given) && cmpKey(a.given) === cmpKey(b.family) && fa) return 0.85;
    const sim = editSimilarity(fa, fb);
    return sim >= 0.85 ? 0.6 : 0;
  }
  const ia = initials(a.given);
  const ib = initials(b.given);
  if (!ia.length || !ib.length) return 0.9;
  if (ia[0] !== ib[0]) return 0.25;
  const [short, long] = ia.length <= ib.length ? [ia, ib] : [ib, ia];
  const initialsCompatible = short.every((x, idx) => long[idx] === x) || short.length === 1;
  // Full given names that disagree ("John" vs "Jane") are a strong negative.
  const ga = givenFull(a.given);
  const gb = givenFull(b.given);
  if (ga.length && gb.length && ga[0] !== gb[0] && !ga[0].startsWith(gb[0]) && !gb[0].startsWith(ga[0])) return 0.3;
  return initialsCompatible ? 1 : 0.8;
}

export interface AuthorComparison {
  score: number;
  firstAuthorMatch: boolean;
  /** Fraction of authors in the shorter list with a match in the other. */
  overlap: number;
  countA: number;
  countB: number;
  /** true when the lists refer to the same people but one has fuller names. */
  otherHasFullerNames: boolean;
  /** true when names are identical after normalisation. */
  identical: boolean;
}

export function compareAuthorLists(a: Author[], b: Author[], aTruncated = false, bTruncated = false): AuthorComparison {
  const res: AuthorComparison = {
    score: 0,
    firstAuthorMatch: false,
    overlap: 0,
    countA: a.length,
    countB: b.length,
    otherHasFullerNames: false,
    identical: false,
  };
  if (!a.length || !b.length) return res;
  res.firstAuthorMatch = authorPairSimilarity(a[0], b[0]) >= 0.8;
  const n = aTruncated || bTruncated ? Math.min(a.length, b.length) : Math.max(a.length, b.length);
  let positional = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) positional += authorPairSimilarity(a[i], b[i]);
  positional /= n;
  // Order-insensitive overlap to tolerate reordering in one source.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const used = new Set<number>();
  let matched = 0;
  for (const x of short) {
    let best = -1;
    let bestScore = 0;
    long.forEach((y, j) => {
      if (used.has(j)) return;
      const s = authorPairSimilarity(x, y);
      if (s > bestScore) {
        bestScore = s;
        best = j;
      }
    });
    if (bestScore >= 0.8) {
      used.add(best);
      matched++;
    }
  }
  res.overlap = matched / short.length;
  const countPenalty = aTruncated || bTruncated ? 1 : Math.min(a.length, b.length) / Math.max(a.length, b.length);
  res.score = Math.max(positional, 0.9 * res.overlap * countPenalty);
  res.identical =
    a.length === b.length &&
    !aTruncated &&
    !bTruncated &&
    a.every((x, i) => cmpKey(x.family) === cmpKey(b[i].family) && cmpKey(x.given) === cmpKey(b[i].given));
  if (res.score >= 0.9 && a.length === b.length) {
    const fuller = b.some((y, i) => givenFull(y.given).length > givenFull(a[i].given).length);
    res.otherHasFullerNames = fuller;
  }
  return res;
}

export type AuthorFormat = 'last-first' | 'first-last';

export function formatAuthor(a: Author, format: AuthorFormat, encode: (s: string) => string = (s) => s): string {
  if (a.literal) return `{${encode(a.literal)}}`;
  const family = encode(a.family);
  const given = encode(a.given);
  if (!given) return family.includes(' ') && format === 'first-last' ? `{${family}}` : family;
  if (format === 'last-first') return `${family}, ${given}`;
  // "First Last" is ambiguous for multi-word surnames without particles; brace them.
  const needsBrace = family.includes(' ') && !/^[a-z]/.test(family);
  return `${given} ${needsBrace ? `{${family}}` : family}`;
}

export function formatAuthorList(list: Author[], format: AuthorFormat, fromUnicode: boolean, truncated = false): string {
  const enc = fromUnicode ? (s: string) => unicodeToLatex(s) : (s: string) => s;
  const names = list.map((a) => formatAuthor(a, format, enc));
  if (truncated) names.push('others');
  return names.join(' and ');
}

export function authorDisplay(a: Author): string {
  if (a.literal) return latexToUnicode(a.literal);
  return latexToUnicode([a.given, a.family].filter(Boolean).join(' '));
}
