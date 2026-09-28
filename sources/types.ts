import { latexToUnicode } from '../core/normalize/latex';
import type { Author, LookupResult, SourceName, Work } from '../core/models/types';

export interface WorkQuery {
  title?: string;
  authors: Author[];
  year?: number;
  venue?: string;
}

/**
 * Adapter contract. Returns LookupResult (not bare Work|null) so callers can
 * always tell "no record" apart from "lookup failed / rate limited /
 * offline" — a source being unavailable is never evidence of anything.
 */
export interface ScholarlySource {
  readonly name: SourceName;
  readonly supportsDoiLookup: boolean;
  lookupByDOI(doi: string): Promise<LookupResult<Work>>;
  searchWork(query: WorkQuery): Promise<LookupResult<Work[]>>;
  getSourceName(): SourceName;
}

export interface SourceSettings {
  /** Optional contact e-mail for Crossref/OpenAlex "polite" pools. Sent only to those services. */
  contactEmail?: string;
  openAlexApiKey?: string;
}

export const sourceSettings: SourceSettings = {};

/** Defensive list access: APIs sometimes return null, an object or an error blob. */
export function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Builds a compact free-text query from title words (no punctuation, bounded length). */
export function titleQuery(title: string | undefined, maxWords = 14): string {
  if (!title) return '';
  const plain = latexToUnicode(title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[{}$\\]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.split(' ').slice(0, maxWords).join(' ');
}

export function firstFamily(authors: Author[]): string {
  const a = authors[0];
  if (!a) return '';
  return (a.literal ?? a.family).replace(/[{}\\'"`^~]/g, '');
}

/** Splits a display name "Given Middle Family" into structured form. */
export function splitDisplayName(name: string): Author {
  const clean = name.replace(/\s+\d{4}$/, '').trim(); // DBLP homonym suffix "Jane Doe 0002"
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return { family: parts[0], given: '' };
  const particles = new Set([
    'van',
    'von',
    'der',
    'den',
    'de',
    'del',
    'della',
    'da',
    'di',
    'du',
    'le',
    'la',
    'dos',
    'das',
    'ter',
    'ten',
    'bin',
    'al',
  ]);
  let k = parts.length - 1;
  while (k > 1 && particles.has(parts[k - 1].toLowerCase())) k--;
  return { family: parts.slice(k).join(' '), given: parts.slice(0, k).join(' ') };
}

export function yearFrom(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').slice(0, 4));
  return Number.isInteger(n) && n > 1500 && n < 2200 ? n : undefined;
}
