/**
 * QA pass: adversarial parser coverage (entry types, exotic syntax, malformed
 * input) and the round-trip invariant that analysis never mutates the source.
 */
import {
  KNOWN_ENTRY_TYPES,
  LIMITS,
  fieldText,
  getField,
  inheritedFields,
  parseBibtex,
  parseSingleEntry,
  valueToText,
} from '../../core/parser/bibtex';
import { applySuggestions } from '../../core/formatter/apply';
import { buildInput } from '../../core/verification/input';

const p = (s: string) => parseBibtex(s);

describe('entry types', () => {
  const types = [
    'article',
    'inproceedings',
    'conference',
    'proceedings',
    'book',
    'inbook',
    'incollection',
    'phdthesis',
    'mastersthesis',
    'techreport',
    'misc',
    'online',
    'software',
    'dataset',
  ];
  it.each(types)('parses @%s', (t) => {
    const r = p(`@${t}{key${t},\n  title = {T},\n  author = {A, B},\n  year = {2020}\n}`);
    expect(r.errors).toEqual([]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].type.toLowerCase()).toBe(t);
    expect(fieldText(r.entries[0], 'title')).toBe('T');
  });
  it('knows the standard types for structural checks', () => {
    for (const t of types) expect(KNOWN_ENTRY_TYPES.map((x) => x.toLowerCase())).toContain(t);
  });
  it('is case-insensitive about the type and field names', () => {
    const r = p('@ARTICLE{k, TITLE = {T}, Author = {A}}');
    expect(r.entries[0].type.toLowerCase()).toBe('article');
    expect(fieldText(r.entries[0], 'title')).toBe('T');
    expect(getField(r.entries[0], 'AUTHOR')).toBeDefined();
  });
});

describe('field syntax', () => {
  it('handles quoted, braced, numeric and macro values with concatenation', () => {
    const r = p('@string{acm = {ACM}}\n@inproceedings{k, booktitle = acm # " Conference", year = 2020, pages = "1--2"}');
    const e = r.entries[0];
    expect(fieldText(e, 'booktitle', r.strings)).toBe('ACM Conference');
    expect(fieldText(e, 'year', r.strings)).toBe('2020');
    expect(fieldText(e, 'pages', r.strings)).toBe('1--2');
  });
  it('keeps nested and escaped braces', () => {
    const r = p('@article{k, title = {A {BERT} study \\{literal\\} end}}');
    expect(fieldText(r.entries[0], 'title')).toBe('A {BERT} study \\{literal\\} end');
  });
  it('accepts empty values, trailing commas and odd whitespace', () => {
    const r = p('@article{k,\n\ttitle\t=\t{},\r\n  note = "" ,\n}');
    expect(r.errors).toEqual([]);
    expect(fieldText(r.entries[0], 'title')).toBe('');
    expect(fieldText(r.entries[0], 'note')).toBe('');
  });
  it('accepts parenthesis-delimited entries', () => {
    const r = p('@article(k, title = {T})');
    expect(r.entries[0].openDelim).toBe('(');
    expect(fieldText(r.entries[0], 'title')).toBe('T');
  });
  it('keeps unknown and custom fields', () => {
    const r = p('@misc{k, title={T}, mycustom={keep}, x-internal-id={42}}');
    expect(fieldText(r.entries[0], 'mycustom')).toBe('keep');
    expect(fieldText(r.entries[0], 'x-internal-id')).toBe('42');
  });
  it('keeps duplicate fields rather than dropping one', () => {
    const r = p('@article{k, year={2020}, year={2021}}');
    expect(r.entries[0].fields.filter((f) => f.name.toLowerCase() === 'year')).toHaveLength(2);
  });
  it('reads multiline values and very long titles', () => {
    const long = 'x'.repeat(5000);
    const r = p(`@article{k, title = {line one\n  line two}, abstract = {${long}}}`);
    expect(fieldText(r.entries[0], 'title')).toContain('line one');
    expect(fieldText(r.entries[0], 'abstract')!.length).toBe(5000);
  });
  it('reports unresolved macros instead of inventing a value', () => {
    const r = p('@article{k, journal = undefinedmacro}');
    const v = valueToText(r.entries[0].fields[0].parts, r.strings);
    expect(v.unresolved).toEqual(['undefinedmacro']);
  });
});

describe('items outside entries', () => {
  it('keeps @preamble and @comment without treating them as entries', () => {
    const r = p('@preamble{"\\newcommand{\\x}{y}"}\n@comment{ignored stuff}\n% a line comment\n@article{k, title={T}}');
    expect(r.entries).toHaveLength(1);
    expect(r.items.some((i) => i.kind === 'preamble')).toBe(true);
    expect(r.items.some((i) => i.kind === 'comment')).toBe(true);
  });
  it('resolves crossref and xdata inheritance for comparison only', () => {
    const r = p('@proceedings{proc, title={Proc of X}, year={2020}, publisher={ACM}}\n@inproceedings{k, title={Paper}, crossref={proc}}');
    const inh = inheritedFields(r.entries[1], r.entries, r.strings);
    expect(inh.get('year')).toBe('2020');
    // the source text is untouched
    expect(r.entries[1].text).not.toContain('2020');
  });
});

describe('malformed input fails safely', () => {
  const bad = [
    '@article{k, title={unclosed',
    '@article{k title={T}}',
    '@article{, title={T}}',
    '@{k, title={T}}',
    '@article{k, = {T}}',
    '@article{k, title="unclosed}',
    '@@@@',
    '@article{k, title={a}}}}}}',
    'plain text with no entry at all',
    '@article{k, title={T}, , , }',
  ];
  it.each(bad)('does not throw on %j', (s) => {
    const started = Date.now();
    const r = p(s);
    expect(Date.now() - started).toBeLessThan(200);
    expect(Array.isArray(r.errors)).toBe(true);
  });
  it('reports a position and line for syntax errors', () => {
    const r = p('@article{k, title={unclosed');
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toMatchObject({ line: expect.any(Number), position: expect.any(Number) });
    expect(r.errors[0].message).toBeTruthy();
  });
  it('resynchronises at the next @ so one bad entry does not eat the file', () => {
    const r = p('@article{bad, title={unclosed\n\n@article{good, title={T}}');
    expect(r.entries.some((e) => e.key === 'good')).toBe(true);
  });
  it('enforces size limits', () => {
    const huge = '@article{k, title={' + 'a'.repeat(LIMITS.maxFieldChars + 10) + '}}';
    const r = p(huge);
    expect(r.errors.length + r.entries.length).toBeGreaterThan(0); // handled, not hung
    const many = '@article{k,' + Array.from({ length: LIMITS.maxFieldsPerEntry + 20 }, (_, i) => `f${i}={v}`).join(',') + '}';
    expect(() => p(many)).not.toThrow();
  });
});

describe('round trip: analysis never mutates the citation', () => {
  const samples = [
    '@article{k,title={T},author={Smith, John},year={2020}}',
    '@inproceedings{k,\n  title     = {A {GPU} Study},\n  author    = {von Berg, Ana and Smith, J.},\n  booktitle = "Proc. of Things",\n  pages     = {1--10},\n  weird     = {keep me},\n}',
    '@string{acm={ACM}}\n@article{k, publisher = acm, title={T}}\n% trailing comment',
    '@misc{k, title={Unicode: naïve café 中文 α β}, note={{nested {braces}}}}',
  ];
  it.each(samples)('parse → build input → apply nothing is byte identical', (src) => {
    const parsed = parseBibtex(src);
    const e = parsed.entries[0];
    const input = buildInput(e, parsed.strings, parsed.entries);
    expect(input.entry.text).toBe(src.slice(e.start, e.end));
    expect(applySuggestions(src, []).text).toBe(src);
    // Re-parsing the untouched text yields the same fields.
    const again = parseBibtex(applySuggestions(src, []).text);
    expect(again.entries[0].fields.map((f) => [f.name, f.raw])).toEqual(e.fields.map((f) => [f.name, f.raw]));
  });
  it('parseSingleEntry does not mutate offsets of the original', () => {
    const src = '@article{k, title={T}}';
    const a = parseSingleEntry(src);
    expect(src.slice(a.entry!.fields[0].valueStart, a.entry!.fields[0].valueEnd)).toBe('{T}');
  });
});
