/**
 * QA pass: source precedence and per-field reporting.
 * Precedence decides what BibCleaner shows first; it must never make a
 * conflicting value disappear.
 */
import { PRECEDENCE, mergeRecords, buildCandidates, rank } from '../../core/matcher/candidates';
import { analyze } from '../../core/verification/pipeline';
import { evaluate, DEFAULT_EVAL_SETTINGS } from '../../core/verification/evaluate';
import { setKV } from '../../core/net/cache';
import { mockSources, work } from '../fixtures/mockSources';
import { buildInput } from '../../core/verification/input';
import { parseBibtex } from '../../core/parser/bibtex';

beforeAll(() => setKV({ get: async () => undefined, set: async () => {}, clear: async () => {} }));

const T = 'Using AI for IoT Security in Smart Homes';
const input = (bib: string) => {
  const p = parseBibtex(bib);
  return buildInput(p.entries[0], p.strings, p.entries);
};

describe('source precedence', () => {
  it('is declared in one place and ordered publisher registry first', () => {
    expect(PRECEDENCE).toEqual(['Crossref', 'DataCite', 'DBLP', 'OpenAlex', 'arXiv']);
    expect(rank(work('Crossref', {}))).toBeLessThan(rank(work('DBLP', {})));
    expect(rank(work('DBLP', {}))).toBeLessThan(rank(work('OpenAlex', {})));
    expect(rank(work('arXiv', {}))).toBe(PRECEDENCE.length - 1);
    expect(rank({ authors: [], sourceRecords: [] })).toBe(PRECEDENCE.length);
  });

  it('takes each field from the highest-precedence source that has it', () => {
    const merged = mergeRecords([
      work('OpenAlex', { title: T, year: 2024, venue: 'Long OpenAlex Venue Name', pages: '1--2' }),
      work('Crossref', { title: T, year: 2024, venue: 'Proceedings of the ACM Conference on Example Security', publisher: 'ACM' }),
      work('DBLP', { title: T, year: 2024, venue: 'EXSEC', venueShort: 'EXSEC' }),
    ]);
    expect(merged.venue).toBe('Proceedings of the ACM Conference on Example Security');
    expect(merged.venueShort).toBe('EXSEC'); // DBLP's short label is kept alongside
    expect(merged.pages).toBe('1--2'); // only OpenAlex had it
    expect(merged.publisher).toBe('ACM');
    expect(merged.sourceRecords.map((r) => r.source)).toEqual(['Crossref', 'DBLP', 'OpenAlex']);
  });

  it('does not let precedence hide a disagreement: every record stays on the candidate', async () => {
    const crossref = work('Crossref', {
      title: T,
      authors: ['John Smith'],
      year: 2024,
      doi: '10.5555/1000001',
      venue: 'Proc of Example',
      type: 'inproceedings',
    });
    const dblp = work('DBLP', {
      title: T,
      authors: ['John Smith'],
      year: 2025,
      doi: '10.5555/1000001',
      venue: 'EXSEC',
      venueShort: 'EXSEC',
      type: 'inproceedings',
    });
    const bib = `@inproceedings{k, title={${T}}, author={Smith, John}, year={2025}, booktitle={Proc of Example}}`;
    const a = await analyze(
      bib,
      { mode: 'clean' },
      mockSources({ records: [crossref, dblp], search: { Crossref: [crossref], DBLP: [dblp] } }),
    );
    const cand = a.candidateSet.candidates.find((c) => c.id === a.candidateSet.selectedId)!;
    expect(cand.records.map((r) => r.sourceRecords[0].source).sort()).toEqual(['Crossref', 'DBLP']);
    const ev = evaluate(a.input!, cand, DEFAULT_EVAL_SETTINGS, undefined, a.doiChecks);
    const year = ev.comparisons.find((c) => c.field === 'year')!;
    expect(year.evidence.map((e) => `${e.source}:${e.value}`).sort()).toEqual(expect.arrayContaining(['Crossref:2024', 'DBLP:2025']));
  });

  it('a lower-precedence record never overwrites a higher one silently', () => {
    const merged = mergeRecords([
      work('Crossref', { title: 'Crossref title', doi: '10.5555/x' }),
      work('arXiv', { title: 'arXiv title', doi: '10.48550/arXiv.1', arxivId: '2401.1' }),
    ]);
    expect(merged.title).toBe('Crossref title');
    expect(merged.doi).toBe('10.5555/x');
    expect(merged.arxivId).toBe('2401.1'); // complementary, not conflicting
  });

  it('candidates below the display threshold are not shown at all', () => {
    const inp = input(`@article{k, title={${T}}, author={Smith, John}, year={2024}}`);
    const junk = work('Crossref', { title: 'Completely Unrelated Chemistry Paper', authors: ['Zed Quinn'], year: 1998, doi: '10.5555/J' });
    const set = buildCandidates(inp, [junk]);
    expect(set.candidates.length).toBe(0);
    expect(set.selectedId).toBeNull();
  });
});

describe('field-level reporting', () => {
  const rec = work('Crossref', {
    title: T,
    authors: ['John Smith', 'Jane Doe'],
    year: 2024,
    venue: 'Proceedings of the ACM Conference on Example Security',
    publisher: 'ACM',
    volume: '7',
    issue: '3',
    pages: '120--131',
    doi: '10.5555/1000001',
    isbn: ['9781234567890'],
    issn: ['1234-5678'],
    type: 'inproceedings',
  });

  it('reports a status for each field it can compare and preserves the rest', async () => {
    const bib = `@inproceedings{k,
  title={${T}},
  author={Smith, John and Doe, Jane},
  booktitle={Proceedings of the ACM Conference on Example Security},
  year={2024},
  pages={120--131},
  publisher={ACM},
  doi={10.5555/1000001},
  note={my own note},
  keywords={iot; security},
  abstract={An abstract.},
  language={english}
}`;
    const a = await analyze(bib, { mode: 'clean' }, mockSources({ records: [rec], search: { Crossref: [rec] } }));
    const cand = a.candidateSet.candidates.find((c) => c.id === a.candidateSet.selectedId)!;
    const ev = evaluate(a.input!, cand, DEFAULT_EVAL_SETTINGS, undefined, a.doiChecks);
    const byField = new Map(ev.comparisons.map((c) => [c.field, c.status]));
    for (const f of ['title', 'author', 'year', 'doi', 'booktitle']) expect(byField.get(f), f).toBe('VERIFIED');
    // fields BibCleaner does not compare are never reported as wrong
    for (const f of ['note', 'keywords', 'abstract', 'language']) expect(byField.has(f), f).toBe(false);
    expect(ev.suggestions.some((s) => ['note', 'keywords', 'abstract', 'language'].includes(s.field))).toBe(false);
    expect(ev.checks.find((c) => c.id === 'match')?.state).toBe('VERIFIED');
  });

  it('reports missing fields as MISSING, not as a conflict', async () => {
    const bib = `@inproceedings{k, title={${T}}, author={Smith, John and Doe, Jane}, booktitle={Proceedings of the ACM Conference on Example Security}, year={2024}}`;
    const a = await analyze(bib, { mode: 'clean' }, mockSources({ records: [rec], search: { Crossref: [rec] } }));
    const cand = a.candidateSet.candidates.find((c) => c.id === a.candidateSet.selectedId)!;
    const ev = evaluate(a.input!, cand, DEFAULT_EVAL_SETTINGS, undefined, a.doiChecks);
    const missing = ev.comparisons.filter((c) => c.status === 'MISSING').map((c) => c.field);
    expect(missing).toEqual(expect.arrayContaining(['doi']));
    expect(ev.comparisons.some((c) => c.status === 'CONFLICT')).toBe(false);
  });

  it('marks fields as not checked when no candidate was selected', async () => {
    const bib = `@article{k, title={An Unknown Paper}, author={Nobody, A}, year={2019}, doi={10.5555/unknown}}`;
    const a = await analyze(bib, { mode: 'clean' }, mockSources({ records: [], unresolvable: ['10.5555/unknown'] }));
    const ev = evaluate(a.input!, null, DEFAULT_EVAL_SETTINGS, undefined, a.doiChecks);
    const statuses = new Set(ev.comparisons.map((c) => c.status));
    expect([...statuses].every((s) => s === 'NOT CHECKED')).toBe(true);
    expect(ev.checks.find((c) => c.id === 'doi-resolve')?.state).toBe('CONFLICT'); // the DOI itself does not exist
  });
});
