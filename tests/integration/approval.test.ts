/**
 * QA pass: the release-critical approval invariant.
 *
 * Nothing the user did not approve may change — not a byte. Every suggestion
 * is exercised individually: accept exactly one, and the output must differ
 * from the original in exactly that one way.
 */
import { analyze } from '../../core/verification/pipeline';
import { evaluate, DEFAULT_EVAL_SETTINGS } from '../../core/verification/evaluate';
import { applySuggestions } from '../../core/formatter/apply';
import { parseBibtex, fieldText } from '../../core/parser/bibtex';
import { acceptAll, decide, rejectAll, setVersionChanges } from '../../ui/review/review';
import { setKV } from '../../core/net/cache';
import { mockSources, work } from '../fixtures/mockSources';
import type { Suggestion } from '../../core/models/types';

beforeAll(() => setKV({ get: async () => undefined, set: async () => {}, clear: async () => {} }));

const T = 'Using AI for IoT Security in Smart Homes';
const cr = work('Crossref', {
  title: T,
  authors: ['John Smith', 'Jane Doe'],
  year: 2024,
  venue: 'Proceedings of the 2024 ACM Conference on Example Security',
  publisher: 'ACM',
  pages: '120-131',
  doi: '10.5555/1000001',
  type: 'inproceedings',
  isbn: ['9781234567890'],
  volume: '3',
  issue: '2',
});
const db = work('DBLP', {
  title: T,
  authors: ['John Smith', 'Jane Doe'],
  year: 2024,
  venue: 'EXSEC',
  venueShort: 'EXSEC',
  pages: '120-131',
  doi: '10.5555/1000001',
  type: 'inproceedings',
});

// A messy but realistic entry: wrong year, missing metadata, quotes, odd spacing,
// a custom field, a comment line and a trailing comma.
const MESSY = `% my note about this paper
@article{smith2025ai,
  title  = "using ai for iot security in smart homes",
  author = {John Smith and Jane Doe},
  year   = {2025},
  mynote = {keep me},
  url    = {https://example.com/paper},
}`;

async function suggestFor(bib: string, mode: 'clean' | 'verify' = 'clean') {
  const a = await analyze(bib, { mode }, mockSources({ records: [cr, db], search: { Crossref: [cr], DBLP: [db] } }));
  const cand = a.candidateSet.candidates.find((c) => c.id === a.candidateSet.selectedId) ?? null;
  const ev = evaluate(a.input!, cand, { ...DEFAULT_EVAL_SETTINGS, mode }, undefined, a.doiChecks);
  return { a, ev };
}

const fieldsOf = (text: string) => {
  const e = parseBibtex(text).entries[0];
  return { key: e.key, type: e.type, fields: new Map(e.fields.map((f) => [f.name.toLowerCase(), fieldText(e, f.name)])) };
};

describe('nothing is accepted by default', () => {
  it('produces suggestions but leaves the citation byte-identical', async () => {
    const { ev } = await suggestFor(MESSY);
    expect(ev.suggestions.length).toBeGreaterThan(3);
    expect(ev.suggestions.every((s) => s.accepted === null)).toBe(true);
    expect(applySuggestions(MESSY, ev.suggestions).text).toBe(MESSY);
    expect(applySuggestions(MESSY, ev.suggestions).appliedIds).toEqual([]);
  });
  it('holds in verify mode too', async () => {
    const { ev } = await suggestFor(MESSY, 'verify');
    expect(applySuggestions(MESSY, ev.suggestions).text).toBe(MESSY);
  });
  it('holds for every fixture in the golden corpus', async () => {
    const { corpus } = await import('../fixtures/citations/corpus');
    for (const fx of corpus) {
      const a = await analyze(fx.bib, { mode: fx.mode ?? 'clean' }, mockSources(fx.data));
      if (!a.input) continue;
      const cand = a.candidateSet.candidates.find((c) => c.id === a.candidateSet.selectedId) ?? null;
      const ev = evaluate(a.input, cand, { ...DEFAULT_EVAL_SETTINGS, mode: fx.mode ?? 'clean' }, undefined, a.doiChecks);
      expect(applySuggestions(fx.bib, ev.suggestions).text, fx.name).toBe(fx.bib);
    }
  }, 30000);
});

describe('accepting exactly one suggestion changes exactly one thing', () => {
  it('each suggestion in isolation', async () => {
    const { ev } = await suggestFor(MESSY);
    const before = fieldsOf(MESSY);
    for (const s of ev.suggestions) {
      const one = ev.suggestions.map((x) => ({ ...x, accepted: x.id === s.id ? true : null }));
      const out = applySuggestions(MESSY, one);
      expect(out.text, `${s.field}: ${s.title}`).not.toBe(MESSY);
      const after = fieldsOf(out.text);

      if (s.patch.kind === 'layout') continue; // whole-entry reformat, checked separately
      if (s.field === 'KEY') {
        expect(after.key).toBe(s.suggestedValue);
        expect([...after.fields]).toEqual([...before.fields]);
        continue;
      }
      if (s.field === 'ENTRYTYPE') {
        expect(`@${after.type}`).toBe(s.suggestedValue);
        continue;
      }
      // The targeted field takes the suggested value...
      const got = after.fields.get(s.field.toLowerCase());
      if (s.patch.kind === 'set') expect(got, s.title).toBe(s.suggestedValue);
      if (s.patch.kind === 'wrap') expect(got, s.title).toContain(`{${s.patch.term}}`);
      if (s.patch.kind === 'remove') expect(after.fields.has(s.field.toLowerCase())).toBe(false);
      // ...and every other field, plus the key and type, are untouched.
      for (const [name, value] of before.fields) {
        if (name === s.field.toLowerCase()) continue;
        expect(after.fields.get(name), `${s.title} must not touch ${name}`).toBe(value);
      }
      expect(after.key).toBe(before.key);
      expect(after.type).toBe(before.type);
      // The comment and the custom field survive every single-suggestion apply.
      expect(out.text).toContain('% my note about this paper');
      expect(out.text).toContain('mynote = {keep me}');
    }
  });

  it('rejecting a suggestion never puts it in the output', async () => {
    const { ev } = await suggestFor(MESSY);
    for (const s of ev.suggestions) {
      const rejectedOne = ev.suggestions.map((x) => ({ ...x, accepted: x.id === s.id ? false : true }) as Suggestion);
      const out = applySuggestions(MESSY, rejectedOne);
      expect(out.appliedIds).not.toContain(s.id);
    }
  });

  it('accept → reject → undo leaves no trace', async () => {
    const { ev } = await suggestFor(MESSY);
    const target = ev.suggestions.find((s) => s.field === 'year')!;
    let list = decide(ev.suggestions, target.id, true);
    expect(applySuggestions(MESSY, list).text).not.toBe(MESSY);
    list = decide(list, target.id, false);
    expect(applySuggestions(MESSY, list).text).toBe(MESSY);
    list = decide(list, target.id, null);
    expect(applySuggestions(MESSY, list).text).toBe(MESSY);
  });
});

describe('bulk actions', () => {
  it('reject all returns the original citation exactly', async () => {
    const { ev } = await suggestFor(MESSY);
    expect(applySuggestions(MESSY, rejectAll(ev.suggestions)).text).toBe(MESSY);
  });
  it('accept all applies every accepted suggestion and nothing else', async () => {
    const { ev } = await suggestFor(MESSY);
    const list = acceptAll(ev.suggestions);
    const out = applySuggestions(MESSY, list);
    const accepted = list.filter((s) => s.accepted === true);
    expect(out.appliedIds.sort()).toEqual(accepted.map((s) => s.id).sort());
    // Key and version changes are never part of a bulk accept.
    expect(list.find((s) => s.field === 'KEY')?.accepted).toBeNull();
    expect(fieldsOf(out.text).key).toBe('smith2025ai');
    expect(out.text).toContain('keep me');
  });
  it('accept all then reject all restores the original', async () => {
    const { ev } = await suggestFor(MESSY);
    expect(applySuggestions(MESSY, rejectAll(acceptAll(ev.suggestions))).text).toBe(MESSY);
  });
  it('version changes need their own approval', async () => {
    const arx = work('arXiv', {
      title: 'Graph Learning for Code Review',
      authors: ['Min Lee'],
      year: 2023,
      venue: 'arXiv',
      arxivId: '2301.00001',
      doi: '10.48550/arXiv.2301.00001',
      isPreprint: true,
      type: 'preprint',
      relatedDois: ['10.5555/2000002'],
    });
    const pub = work('Crossref', {
      title: 'Graph Learning for Code Review',
      authors: ['Min Lee'],
      year: 2024,
      venue: 'Proc. of Example',
      doi: '10.5555/2000002',
      type: 'inproceedings',
      pages: '1--12',
    });
    const bib = `@article{lee2023,\n  title={Graph Learning for Code Review},\n  author={Lee, Min},\n  journal={arXiv preprint arXiv:2301.00001},\n  year={2023}\n}`;
    const a = await analyze(bib, { mode: 'clean' }, mockSources({ records: [arx, pub], search: { Crossref: [pub] } }));
    const cand = a.candidateSet.candidates.find((c) => c.id === a.candidateSet.selectedId) ?? null;
    const ev = evaluate(a.input!, cand, DEFAULT_EVAL_SETTINGS, undefined, a.doiChecks);
    const version = ev.suggestions.filter((s) => s.category === 'version');
    expect(version.length).toBeGreaterThan(0);
    // Bulk accept leaves them alone; the preprint citation is preserved.
    const bulk = applySuggestions(bib, acceptAll(ev.suggestions)).text;
    expect(bulk).toContain('arXiv preprint arXiv:2301.00001');
    expect(bulk).not.toContain('10.5555/2000002');
    // Explicit conversion applies them all at once.
    const converted = applySuggestions(bib, setVersionChanges(ev.suggestions, true)).text;
    expect(converted).toContain('10.5555/2000002');
  });
});

describe('formatting suggestions are independent of metadata suggestions', () => {
  it('accepting only capitalization protection leaves layout and fields alone', async () => {
    const bib = '@inproceedings{k,\n  title={Using AI for IoT Security},\n  author={Smith, John},\n  year={2024}\n}';
    const capRecord = work('Crossref', {
      title: 'Using AI for IoT Security',
      authors: ['John Smith'],
      year: 2024,
      doi: '10.5555/3000003',
      venue: 'Proc of Example',
      type: 'inproceedings',
    });
    const a = await analyze(bib, { mode: 'clean' }, mockSources({ records: [capRecord], search: { Crossref: [capRecord] } }));
    const cand = a.candidateSet.candidates.find((c) => c.id === a.candidateSet.selectedId)!;
    const ev = evaluate(a.input!, cand, DEFAULT_EVAL_SETTINGS, undefined, a.doiChecks);
    const caps = ev.suggestions.filter((s) => s.patch.kind === 'wrap');
    expect(caps.map((s) => s.suggestedValue).sort()).toEqual(['{AI}', '{IoT}']);
    const out = applySuggestions(
      bib,
      ev.suggestions.map((s) => ({ ...s, accepted: s.patch.kind === 'wrap' ? true : false })),
    );
    expect(out.text).toContain('{Using {AI} for {IoT} Security}');
    expect(out.text).not.toContain('doi');
    // Indentation and field order are untouched.
    expect(out.text.split('\n')[2]).toBe('  author={Smith, John},');
  });
});
