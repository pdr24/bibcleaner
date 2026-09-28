/** Normalises page ranges: "123-134", "123–134", "123 -- 134" -> "123--134". */
export function normalizePages(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim().replace(/\s+/g, ' ');
  const m = s.match(/^([A-Za-z]?\d+[A-Za-z]?)\s*(?:-{1,3}|–|—|‐|\u2212)\s*([A-Za-z]?\d+[A-Za-z]?)$/);
  if (m) return `${m[1]}--${m[2]}`;
  return s;
}

/** Comparison key for pages; treats "123--134" and "123-134" as equal. */
export function pagesKey(raw: string | undefined): string {
  const n = normalizePages(raw);
  return n ? n.toLowerCase().replace(/-+/g, '-') : '';
}

/** Expands abbreviated ranges like 1234--56 -> 1234--1256 for comparison only. */
export function pagesEquivalent(a: string | undefined, b: string | undefined): boolean {
  const ka = pagesKey(a);
  const kb = pagesKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const expand = (k: string) => {
    const [s, e] = k.split('-');
    if (e && /^\d+$/.test(s) && /^\d+$/.test(e) && e.length < s.length) return `${s}-${s.slice(0, s.length - e.length)}${e}`;
    return k;
  };
  return expand(ka) === expand(kb);
}
