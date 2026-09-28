import type { Work } from '../models/types';
import { foldDiacritics, STOPWORDS } from '../normalize/text';
import { latexToUnicode } from '../normalize/latex';
import { venueAbbrev } from '../normalize/venue';

export interface KeyScheme {
  /** Ordered components. Default: author_year_keyword_venue (PRD §32). */
  parts: ('author' | 'year' | 'keyword' | 'venue')[];
  separator: string;
  lowercase: boolean;
}

export const DEFAULT_KEY_SCHEME: KeyScheme = { parts: ['author', 'year', 'keyword', 'venue'], separator: '_', lowercase: true };

const ascii = (s: string) => foldDiacritics(latexToUnicode(s)).replace(/[^A-Za-z0-9]/g, '');

export function generateKey(w: Work, scheme: KeyScheme = DEFAULT_KEY_SCHEME, existingKeys: Set<string> = new Set()): string | undefined {
  const a = w.authors[0];
  const pieces: string[] = [];
  for (const p of scheme.parts) {
    if (p === 'author' && a) {
      const fam = latexToUnicode(a.literal ?? a.family).split(/\s+/);
      // Skip lowercase particles ("van der Berg" -> "berg" is surprising; keep "vanderberg").
      pieces.push(ascii(fam.join('')));
    }
    if (p === 'year' && w.year) pieces.push(String(w.year));
    if (p === 'keyword' && w.title) {
      const word = latexToUnicode(w.title)
        .split(/[\s\-:;,.?!()[\]/]+/)
        .map((x) => ascii(x))
        .find((x) => x.length >= 3 && !STOPWORDS.has(x.toLowerCase()));
      if (word) pieces.push(word);
    }
    if (p === 'venue') {
      const v = w.isPreprint ? 'arxiv' : venueAbbrev(w.venue, w.venueShort);
      if (v) pieces.push(v);
    }
  }
  if (pieces.length < 2) return undefined;
  let key = pieces.filter(Boolean).join(scheme.separator);
  if (scheme.lowercase) key = key.toLowerCase();
  if (!existingKeys.has(key)) return key;
  for (let i = 0; i < 26; i++) {
    const k = `${key}${scheme.separator}${String.fromCharCode(97 + i)}`;
    if (!existingKeys.has(k)) return k;
  }
  return undefined;
}
