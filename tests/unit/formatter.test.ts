import { detectProtectionTerms, wrapTerm } from '../../core/formatter/capitalization';
import { generateKey } from '../../core/formatter/citekey';
import { applySuggestions } from '../../core/formatter/apply';
import { lineDiff } from '../../core/diff/lineDiff';
import type { Suggestion } from '../../core/models/types';

const sug = (p: Partial<Suggestion> & Pick<Suggestion, 'field' | 'patch'>): Suggestion => ({
  id: Math.random().toString(36).slice(2),
  operation: 'replace',
  category: 'format',
  title: '',
  suggestedValue: '',
  confidence: 'HIGH',
  reason: '',
  sources: [],
  accepted: true,
  ...p,
});

describe('capitalization protection', () => {
  it('finds acronyms and mixed case', () => {
    expect(detectProtectionTerms('Using AI for IoT Malware Detection on iPhone').map((t) => t.term)).toEqual(['AI', 'IoT', 'iPhone']);
  });
  it('skips already-protected terms, math and commands', () => {
    expect(detectProtectionTerms('Using {AI} and $O(N)$ with \\LaTeX')).toEqual([]);
  });
  it('ignores ALL CAPS titles', () => expect(detectProtectionTerms('A STUDY OF DEEP LEARNING MODELS')).toEqual([]));
  it('wraps whole words only', () => expect(wrapTerm('AI and AIDS and AI', 'AI')).toBe('{AI} and AIDS and {AI}'));
  it('suggests likely proper names', () =>
    expect(detectProtectionTerms('Teaching Loops with Scratch').map((t) => t.term)).toEqual(['Scratch']));
});

describe('citation keys', () => {
  const w = {
    title: 'Detecting Malware with Graphs',
    authors: [{ family: 'Smith', given: 'John' }],
    year: 2025,
    venue: 'Proceedings of CCS',
    venueShort: 'CCS',
    sourceRecords: [],
  };
  it('follows author_year_keyword_venue', () => expect(generateKey(w)).toBe('smith_2025_detecting_ccs'));
  it('suffixes collisions', () =>
    expect(generateKey(w, undefined, new Set(['smith_2025_detecting_ccs']))).toBe('smith_2025_detecting_ccs_a'));
  it('is ASCII-safe', () =>
    expect(generateKey({ ...w, authors: [{ family: 'M{\\"u}ller', given: 'H' }] })).toBe('muller_2025_detecting_ccs'));
});

describe('applying suggestions', () => {
  const src =
    '@inproceedings{smith2025ai,\n  title={using AI for IoT security},\n  author={Smith, John and Doe, Jane},\n  year={2025},\n  x-custom = {keep},\n  url={https://example.com/paper}\n}';

  it('changes nothing when nothing is accepted', () => {
    expect(applySuggestions(src, [sug({ field: 'year', patch: { kind: 'set', value: '2024' }, accepted: null })]).text).toBe(src);
    expect(applySuggestions(src, [sug({ field: 'year', patch: { kind: 'set', value: '2024' }, accepted: false })]).text).toBe(src);
  });

  it('patches only the accepted value', () => {
    const out = applySuggestions(src, [sug({ field: 'year', patch: { kind: 'set', value: '2024' } })]).text;
    expect(out).toBe(src.replace('year={2025}', 'year={2024}'));
  });

  it('inserts new fields in the entry style', () => {
    const out = applySuggestions(src, [sug({ field: 'doi', patch: { kind: 'set', value: '10.1145/1' } })]).text;
    expect(out).toContain('url={https://example.com/paper},\n  doi={10.1145/1}\n}');
  });

  it('inserts after a trailing comma', () => {
    const s2 = '@misc{k,\n  title = {T},\n}';
    expect(applySuggestions(s2, [sug({ field: 'year', patch: { kind: 'set', value: '2020' } })]).text).toBe(
      '@misc{k,\n  title = {T},\n  year = {2020},\n}',
    );
  });

  it('keeps alignment when fields are aligned', () => {
    const s3 = '@misc{k,\n  title  = {T},\n  author = {A}\n}';
    expect(applySuggestions(s3, [sug({ field: 'doi', patch: { kind: 'set', value: '10.1/x' } })]).text).toBe(
      '@misc{k,\n  title  = {T},\n  author = {A},\n  doi    = {10.1/x}\n}',
    );
  });

  it('wraps terms and composes with a title replacement', () => {
    const out = applySuggestions(src, [
      sug({ field: 'title', patch: { kind: 'wrap', term: 'AI' } }),
      sug({ field: 'title', patch: { kind: 'wrap', term: 'IoT' } }),
    ]).text;
    expect(out).toContain('title={using {AI} for {IoT} security}');
    const out2 = applySuggestions(src, [
      sug({ field: 'title', patch: { kind: 'wrap', term: 'AI' } }),
      sug({ field: 'title', patch: { kind: 'set', value: 'Using AI for IoT Security' } }),
    ]).text;
    expect(out2).toContain('title={Using {AI} for IoT Security}');
  });

  it('removes and renames fields only when accepted', () => {
    const out = applySuggestions(src, [sug({ field: 'url', patch: { kind: 'remove' } })]).text;
    expect(out).not.toContain('url=');
    expect(out).toContain('x-custom = {keep}\n}');
    const out2 = applySuggestions('@article{k, journal={X}, year={1}}', [
      sug({ field: 'journal', patch: { kind: 'rename', to: 'booktitle' } }),
    ]).text;
    expect(out2).toBe('@article{k, booktitle={X}, year={1}}');
  });

  it('changes type and key', () => {
    const out = applySuggestions(src, [
      sug({ field: 'ENTRYTYPE', patch: { kind: 'set', value: 'article' } }),
      sug({ field: 'KEY', patch: { kind: 'set', value: 'smith_2025' } }),
    ]).text;
    expect(out.startsWith('@article{smith_2025,')).toBe(true);
  });

  it('layout keeps custom fields and macros', () => {
    const s = '@article{k, year = 2020, journal = tocs, title = "A", x-note = {z}}';
    const out = applySuggestions(s, [sug({ field: 'ENTRY', patch: { kind: 'layout' } })]).text;
    expect(out).toBe('@article{k,\n  title   = {A},\n  journal = tocs,\n  year    = 2020,\n  x-note  = {z}\n}');
  });

  it('refuses to wrap macro values', () => {
    const r = applySuggestions('@article{k, title = t1 # "AI"}', [sug({ field: 'title', patch: { kind: 'wrap', term: 'AI' } })]);
    expect(r.skipped.length).toBe(1);
  });
});

describe('diff', () => {
  it('produces a line diff', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc\nd');
    expect(d.map((l) => l.kind)).toEqual(['same', 'del', 'add', 'same', 'add']);
  });
});
