import { parseBibtex, valueToText, fieldText, LIMITS } from '../../core/parser/bibtex';

describe('BibTeX parser', () => {
  it('parses a basic entry with spans', () => {
    const src =
      '@inproceedings{smith2025ai,\n  title={using ai for iot security},\n  author={Smith, John and Doe, Jane},\n  year={2025},\n  url={https://example.com/paper}\n}';
    const r = parseBibtex(src);
    expect(r.errors).toEqual([]);
    const e = r.entries[0];
    expect(e.type).toBe('inproceedings');
    expect(e.key).toBe('smith2025ai');
    expect(e.fields.map((f) => f.name)).toEqual(['title', 'author', 'year', 'url']);
    const t = e.fields[0];
    expect(src.slice(t.valueStart, t.valueEnd)).toBe('{using ai for iot security}');
    expect(src.slice(t.nameStart, t.nameEnd)).toBe('title');
    expect(src.slice(e.typeStart, e.typeEnd)).toBe('inproceedings');
  });

  it('handles quotes, numbers, macros, concatenation and @string', () => {
    const src = '@string{acm = "ACM Press"}\n@book{k, publisher = acm # " (New York)", year = 2020, title = "A {B}ook", month = jan}';
    const r = parseBibtex(src);
    expect(r.errors).toEqual([]);
    const e = r.entries[0];
    expect(fieldText(e, 'publisher', r.strings)).toBe('ACM Press (New York)');
    expect(fieldText(e, 'year', r.strings)).toBe('2020');
    expect(fieldText(e, 'title', r.strings)).toBe('A {B}ook');
    expect(fieldText(e, 'month', r.strings)).toBe('January');
  });

  it('reports undefined macros instead of dropping them', () => {
    const r = parseBibtex('@article{k, journal = tocs}');
    expect(valueToText(r.entries[0].fields[0].parts, r.strings)).toEqual({ text: 'tocs', unresolved: ['tocs'] });
  });

  it('keeps comments, preambles and parenthesis-delimited entries', () => {
    const src = '% my refs\n@preamble{"\\newcommand{\\x}{y}"}\n@comment{ignored {nested}}\nstray text\n@misc(k1, title={X})';
    const r = parseBibtex(src);
    expect(r.errors).toEqual([]);
    expect(r.items.map((i) => i.kind)).toEqual(['comment', 'preamble', 'comment', 'comment', 'entry']);
    expect(r.entries[0].openDelim).toBe('(');
  });

  it('preserves unknown/custom fields', () => {
    const r = parseBibtex('@article{k, title={T}, x-my-field = {keep me}, file={:a.pdf:PDF}}');
    expect(r.entries[0].fields.map((f) => f.name)).toEqual(['title', 'x-my-field', 'file']);
  });

  it('recovers from malformed entries and continues', () => {
    const src = '@article{bad, title={unclosed}\n@article{good, title={Fine}}';
    const r = parseBibtex(src);
    expect(r.errors.length).toBe(1);
    expect(r.entries.map((e) => e.key)).toEqual(['good']);
  });

  it('reports unbalanced braces with a line number', () => {
    const r = parseBibtex('@article{k,\n title={a {b}\n}');
    expect(r.errors[0].message).toMatch(/Unbalanced|missing/i);
    expect(r.errors[0].line).toBeGreaterThanOrEqual(1);
  });

  it('ignores @ in e-mail addresses', () => {
    const r = parseBibtex('contact me@example.com\n@misc{k, title={T}}');
    expect(r.entries.length).toBe(1);
  });

  it('enforces nesting depth limits without recursion', () => {
    const deep = '@misc{k, title={' + '{'.repeat(LIMITS.maxBraceDepth + 5) + 'x' + '}'.repeat(LIMITS.maxBraceDepth + 5) + '}}';
    const r = parseBibtex(deep);
    expect(r.errors[0].message).toMatch(/nested too deeply/);
  });

  it('handles pathological input quickly', () => {
    const t0 = Date.now();
    parseBibtex('@'.repeat(200_000) + '{'.repeat(100_000));
    parseBibtex('@article{k, title="' + 'a'.repeat(50_000));
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('parses a single entry in well under 100 ms', () => {
    const src = '@article{k,\n' + Array.from({ length: 40 }, (_, i) => `  f${i} = {value ${i} with {braces} and \\'e}`).join(',\n') + '\n}';
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) parseBibtex(src);
    expect((performance.now() - t0) / 20).toBeLessThan(100);
  });
});
