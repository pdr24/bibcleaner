/**
 * QA pass: citation keys, capitalization protection, diffs, and the patcher's
 * behaviour on awkward entries.
 */
import { DEFAULT_KEY_SCHEME, generateKey } from '../../core/formatter/citekey';
import { detectProtectionTerms, wrapTerm } from '../../core/formatter/capitalization';
import { applySuggestions } from '../../core/formatter/apply';
import { lineDiff } from '../../core/diff/lineDiff';
import { parseBibtex, fieldText } from '../../core/parser/bibtex';
import type { Author, Suggestion, Work } from '../../core/models/types';

const A = (s: string): Author => {
  const parts = s.split(' ');
  return { family: parts.pop()!, given: parts.join(' ') };
};
const W = (o: Omit<Partial<Work>, 'authors'> & { authors?: string[] }): Work =>
  ({ ...o, authors: (o.authors ?? []).map(A), sourceRecords: [] }) as Work;
const set = (field: string, value: string, over: Partial<Suggestion> = {}): Suggestion => ({
  id: `${field}-1`,
  field,
  operation: 'replace',
  category: 'conflict',
  patch: { kind: 'set', value },
  title: `set ${field}`,
  suggestedValue: value,
  confidence: 'HIGH',
  reason: 'test',
  sources: [],
  accepted: true,
  ...over,
});

describe('citation keys', () => {
  const base = {
    title: 'Detecting Malware with Graph Neural Networks',
    authors: ['John Smith'],
    year: 2025,
    venue: 'ACM Conference on Computer and Communications Security',
    venueShort: 'CCS',
  };
  it('follows author_year_keyword_venue', () => {
    expect(generateKey(W(base))).toBe('smith_2025_detecting_ccs');
  });
  it('is deterministic', () => {
    const k = generateKey(W(base));
    for (let i = 0; i < 10; i++) expect(generateKey(W(base))).toBe(k);
  });
  it('produces LaTeX-safe keys from Unicode, punctuation and spaces', () => {
    const k = generateKey(W({ ...base, authors: ["O'Brien-Müller, Ana".replace(', ', ' ')], title: 'Étude: “Smart” Homes & Things' }))!;
    expect(k).toMatch(/^[A-Za-z0-9_:.-]+$/);
    expect(k).not.toMatch(/[\s{}\\,"'#%&~^$]/);
  });
  it('drops components it has no data for and refuses to emit a one-part key', () => {
    expect(generateKey(W({ title: 'Only a Title Here' }))).toBeUndefined();
    expect(generateKey(W({ authors: ['John Smith'], year: 2020 }))).toBe('smith_2020');
    expect(generateKey(W({ authors: [], year: 2020, title: 'Nothing' }))).toBe('2020_nothing');
  });
  it('handles titles with no meaningful words', () => {
    expect(generateKey(W({ authors: ['John Smith'], year: 2020, title: 'A An The Of' }))).toBe('smith_2020');
  });
  it('truncates nothing but stays reasonable on an extremely long title', () => {
    const k = generateKey(W({ authors: ['John Smith'], year: 2020, title: 'Supercalifragilistic ' + 'x'.repeat(500) }))!;
    expect(k.length).toBeLessThan(60);
  });
  it('adds a suffix for collisions and gives up rather than looping', () => {
    const taken = new Set(['smith_2025_detecting_ccs']);
    expect(generateKey(W(base), DEFAULT_KEY_SCHEME, taken)).toBe('smith_2025_detecting_ccs_a');
    const all = new Set([...taken, ...'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => `smith_2025_detecting_ccs_${c}`)]);
    expect(generateKey(W(base), DEFAULT_KEY_SCHEME, all)).toBeUndefined();
  });
  it('respects a custom scheme', () => {
    expect(generateKey(W(base), { parts: ['author', 'year'], separator: '-', lowercase: false })).toBe('Smith-2025');
  });
  it('marks preprints as arxiv rather than inventing a venue', () => {
    expect(generateKey(W({ ...base, venue: 'arXiv', venueShort: undefined, isPreprint: true }))).toBe('smith_2025_detecting_arxiv');
  });
});

describe('capitalization protection is conservative', () => {
  const terms = (t: string) => detectProtectionTerms(t).map((x) => x.term);
  it.each(['AI', 'ML', 'LLM', 'IoT', 'GPU', 'CPU', 'CNN', 'RNN', 'BERT', 'GPT', 'ImageNet', 'PyTorch'])('protects %s', (t) => {
    expect(terms(`A Study of ${t} in Practice`)).toContain(t);
  });
  it('protects terms with digits and hyphens as written', () => {
    expect(terms('Lessons from COVID-19 and 5G Networks').join(' ')).toMatch(/COVID/);
  });
  it('does not propose protecting ordinary words or sentence-initial words', () => {
    expect(terms('Learning to rank documents for search')).toEqual([]);
    expect(terms('Deep learning for image classification')).toEqual([]);
  });
  it('ignores terms already protected by braces or inside math', () => {
    expect(terms('A Study of {AI} in Practice')).not.toContain('AI');
    expect(terms('Bounds on $O(N \\log N)$ Sorting')).not.toContain('N');
  });
  it('does not fire on an all-caps title (nothing to distinguish)', () => {
    expect(terms('A STUDY OF MACHINE LEARNING')).toEqual([]);
  });
  it('wraps only unprotected whole-word occurrences', () => {
    expect(wrapTerm('AI for AI-based {AI} systems', 'AI')).toBe('{AI} for {AI}-based {AI} systems');
    expect(wrapTerm('Retail and RETAILING', 'AI')).toBe('Retail and RETAILING');
  });
  it('wrapping is idempotent', () => {
    const once = wrapTerm('A Study of IoT', 'IoT');
    expect(wrapTerm(once, 'IoT')).toBe(once);
  });
});

describe('patching awkward entries', () => {
  it('keeps quoted values quoted when only wrapping capitalization', () => {
    const src = '@article{k, title = "A Study of AI", year = {2020}}';
    const out = applySuggestions(src, [
      set('title', '{AI}', { patch: { kind: 'wrap', term: 'AI' }, operation: 'format', category: 'format' }),
    ]);
    expect(out.text).toBe('@article{k, title = "A Study of {AI}", year = {2020}}');
  });
  it('refuses to wrap a macro or concatenated value and says why', () => {
    const src = '@string{t = {A Study of AI}}\n@article{k, title = t}';
    const out = applySuggestions(src, [set('title', '{AI}', { patch: { kind: 'wrap', term: 'AI' } })]);
    expect(out.text).toBe(src);
    expect(out.skipped[0].reason).toMatch(/macro|concatenation/i);
  });
  it('refuses a rename onto an existing field', () => {
    const src = '@article{k, journal={J}, booktitle={B}}';
    const out = applySuggestions(src, [set('journal', 'booktitle', { patch: { kind: 'rename', to: 'booktitle' }, operation: 'rename' })]);
    expect(out.text).toBe(src);
    expect(out.skipped[0].reason).toMatch(/already exists/i);
  });
  it('inserts a new field without disturbing alignment or the trailing comma style', () => {
    const src = '@article{k,\n  title  = {T},\n  year   = {2020},\n}';
    const out = applySuggestions(src, [set('doi', '10.5555/1', { operation: 'add' })]);
    expect(out.text).toContain('doi');
    expect(
      out.text
        .split('\n')
        .filter((l) => l.includes('='))
        .every((l) => /=\s/.test(l)),
    ).toBe(true);
    expect(parseBibtex(out.text).errors).toEqual([]);
    expect(fieldText(parseBibtex(out.text).entries[0], 'title')).toBe('T');
  });
  it('removing a field leaves the rest parseable and intact', () => {
    const src = '@article{k,\n  journal = {arXiv preprint},\n  title = {T},\n  year = {2020}\n}';
    const out = applySuggestions(src, [set('journal', '', { patch: { kind: 'remove' }, operation: 'remove' })]);
    const e = parseBibtex(out.text).entries[0];
    expect(e.fields.map((f) => f.name)).toEqual(['title', 'year']);
    expect(parseBibtex(out.text).errors).toEqual([]);
  });
  it('escapes nothing and preserves values containing braces and LaTeX', () => {
    const src = '@article{k, title={T}}';
    const value = 'Na\\"{\\i}ve {BERT} $O(n^2)$';
    const out = applySuggestions(src, [set('title', value)]);
    expect(fieldText(parseBibtex(out.text).entries[0], 'title')).toBe(value);
  });
  it('applies at most one value per field even with conflicting accepted suggestions', () => {
    const src = '@article{k, year={2020}}';
    const out = applySuggestions(src, [set('year', '2021', { id: 'a' }), set('year', '2022', { id: 'b' })]);
    const e = parseBibtex(out.text).entries[0];
    expect(e.fields.filter((f) => f.name === 'year')).toHaveLength(1);
    expect(['2021', '2022']).toContain(fieldText(e, 'year'));
  });
  it('layout keeps duplicate, custom and macro fields', () => {
    const src = '@string{acm={ACM}}\n@article{k, publisher = acm, year={2020}, year={2021}, weird={x}}';
    const out = applySuggestions(src, [
      set('ENTRY', '', { patch: { kind: 'layout' }, field: 'ENTRY', operation: 'format', category: 'format' }),
    ]);
    expect(out.text).toContain('acm');
    expect(out.text).toContain('weird');
    expect((out.text.match(/year/g) ?? []).length).toBe(2);
  });
});

describe('diffs', () => {
  it('is empty when nothing changed', () => {
    const a = '@article{k, year={2020}}';
    expect(lineDiff(a, a).every((l) => l.kind === 'same')).toBe(true);
  });
  it('shows exactly the lines that changed', () => {
    const a = '@article{k,\n  year={2020},\n  title={T}\n}';
    const b = '@article{k,\n  year={2021},\n  title={T}\n}';
    const d = lineDiff(a, b);
    expect(d.filter((l) => l.kind === 'add').map((l) => l.text.trim())).toEqual(['year={2021},']);
    expect(d.filter((l) => l.kind === 'del').map((l) => l.text.trim())).toEqual(['year={2020},']);
  });
  it('handles multiline values, Unicode and braces', () => {
    const a = '@article{k,\n  title={Naïve\n  Bayes},\n}';
    const b = '@article{k,\n  title={Na{\\"i}ve\n  Bayes},\n}';
    const d = lineDiff(a, b);
    expect(d.some((l) => l.kind === 'add' && l.text.includes('Na{\\"i}ve'))).toBe(true);
  });
  it('a rejected change never reaches the diff', () => {
    const src = '@article{k, year={2020}}';
    const rejected: Suggestion = set('year', '2021', { accepted: false });
    const out = applySuggestions(src, [rejected]);
    expect(lineDiff(src, out.text).every((l) => l.kind === 'same')).toBe(true);
  });
});
