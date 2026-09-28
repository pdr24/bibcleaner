/**
 * DOI extraction and normalisation. All of these map to the same DOI:
 *   10.1145/1234567.1234568
 *   doi:10.1145/1234567.1234568
 *   https://doi.org/10.1145/1234567.1234568
 *   http://dx.doi.org/10.1145/1234567.1234568
 */

const DOI_CORE = /^10\.\d{4,9}\/\S+$/;

export interface ParsedDoi {
  /** Canonical form: bare, prefix lowercased-insensitive comparison uses `key`. */
  doi: string;
  /** Case-folded comparison key (DOIs are case-insensitive). */
  key: string;
  /** true if the raw text was already in canonical bare form. */
  wasCanonical: boolean;
}

export function parseDoi(raw: string | undefined): ParsedDoi | null {
  if (!raw) return null;
  let s = raw.trim();
  // Strip LaTeX escapes that sometimes appear in doi fields (10.1000/abc\_def).
  s = s.replace(/\\([_%&#])/g, '$1').replace(/[{}]/g, '');
  const original = s;
  s = s.replace(/^doi:\s*/i, '');
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  s = s.replace(/^https?:\/\/(www\.)?doi\.org\//i, '');
  try {
    if (s.includes('%2F') || s.includes('%2f')) s = decodeURIComponent(s);
  } catch {
    /* keep as is */
  }
  s = s.replace(/[.,;]+$/, '');
  if (!DOI_CORE.test(s)) return null;
  if (s.length > 300) return null;
  return { doi: s, key: s.toLowerCase(), wasCanonical: s === original };
}

export function sameDoi(a: string | undefined, b: string | undefined): boolean {
  const pa = parseDoi(a);
  const pb = parseDoi(b);
  return !!pa && !!pb && pa.key === pb.key;
}

/** Finds a DOI embedded in arbitrary text (e.g. a url or note field). */
export function findDoiInText(text: string | undefined): string | null {
  if (!text) return null;
  const m = text.match(/10\.\d{4,9}\/[^\s"<>{}]+/);
  if (!m) return null;
  return parseDoi(m[0])?.doi ?? null;
}

export function doiUrl(doi: string): string {
  return (
    'https://doi.org/' +
    doi
      .split('/')
      .map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg).replace(/%2F/gi, '/')))
      .join('/')
  );
}

export function isArxivDoi(doi: string | undefined): boolean {
  return !!doi && /^10\.48550\/arxiv\./i.test(doi);
}
