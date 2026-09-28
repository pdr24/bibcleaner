/**
 * QA pass: the pipeline under source failures, disagreement, ambiguity and
 * degraded evidence. Core rule: an unavailable source is never evidence, and
 * the system prefers "I don't know" over a guess.
 */
import { analyze, type Sources } from '../../core/verification/pipeline';
import { evaluate, DEFAULT_EVAL_SETTINGS } from '../../core/verification/evaluate';
import { applySuggestions } from '../../core/formatter/apply';
import { setKV } from '../../core/net/cache';
import { mockSources, work, type MockData } from '../fixtures/mockSources';
import type { Suggestion } from '../../core/models/types';

beforeEach(() => setKV({ get: async () => undefined, set: async () => {}, clear: async () => {} }));

const T = 'Using AI for IoT Security in Smart Homes';
const AUTH = ['John Smith', 'Jane Doe'];
const cr = work('Crossref', {
  title: T,
  authors: AUTH,
  year: 2024,
  venue: 'Proceedings of the ACM Conference on Example Security',
  publisher: 'ACM',
  pages: '120-131',
  doi: '10.5555/1000001',
  type: 'inproceedings',
});
const dblp = work('DBLP', {
  title: T,
  authors: AUTH,
  year: 2024,
  venue: 'EXSEC',
  venueShort: 'EXSEC',
  pages: '120-131',
  doi: '10.5555/1000001',
  type: 'inproceedings',
});

const bib = (fields: string) => `@inproceedings{k,\n${fields}\n}`;
const full = bib(
  `  title={${T}},\n  author={Smith, John and Doe, Jane},\n  booktitle={Proceedings of the ACM Conference on Example Security},\n  year={2024}`,
);

async function run(src: string, data: MockData, mode: 'clean' | 'verify' = 'clean') {
  const sources = mockSources(data);
  const a = await analyze(src, { mode }, sources);
  const cand = a.candidateSet.candidates.find((c) => c.id === a.candidateSet.selectedId) ?? null;
  const ev = a.input
    ? evaluate(a.input, cand, { ...DEFAULT_EVAL_SETTINGS, mode }, undefined, a.doiChecks)
    : { suggestions: [] as Suggestion[], checks: [], comparisons: [] };
  return { a, cand, ev, calls: sources.calls };
}

describe('source availability is never evidence', () => {
  it.each(['LOOKUP FAILED', 'RATE LIMITED', 'NETWORK UNAVAILABLE'] as const)(
    'a %s from every source leaves the citation NOT CHECKED, not wrong',
    async (failure) => {
      const { a, cand, ev } = await run(full, {
        records: [cr, dblp],
        fail: { Crossref: failure, DBLP: failure, OpenAlex: failure, DataCite: failure, 'DOI resolver': failure },
      });
      expect(cand).toBeNull();
      expect(a.unavailable.length).toBeGreaterThan(0);
      expect(ev.suggestions.filter((s) => s.category === 'conflict' || s.category === 'missing')).toEqual([]);
      expect(ev.checks.some((c) => c.state === 'CONFLICT')).toBe(false);
    },
  );

  it('a rate-limited source is never reported as "DOI does not exist"', async () => {
    const withDoi = bib(`  title={${T}},\n  author={Smith, John and Doe, Jane},\n  year={2024},\n  doi={10.5555/1000001}`);
    const { a, ev } = await run(withDoi, { records: [dblp], fail: { Crossref: 'RATE LIMITED', DataCite: 'RATE LIMITED' } });
    const meta = ev.checks.find((c) => c.id === 'doi-meta')!;
    expect(meta.state).toBe('NOT CHECKED');
    expect(meta.label).not.toMatch(/no metadata record|does not exist/i);
    expect(a.unavailable).toContain('Crossref');
  });

  it('one provider failing does not stop the analysis', async () => {
    const { cand, a } = await run(full, { records: [cr, dblp], fail: { Crossref: 'LOOKUP FAILED' } });
    expect(cand?.work.title).toBe(T);
    expect(a.unavailable).toEqual(['Crossref']);
  });

  it('an adapter that throws is treated as unavailable, not as a crash', async () => {
    const boom: Sources = {
      ...mockSources({ records: [dblp] }),
      crossref: {
        name: 'Crossref',
        supportsDoiLookup: true,
        getSourceName: () => 'Crossref',
        lookupByDOI: async () => {
          throw new TypeError('x.map is not a function');
        },
        searchWork: async () => {
          throw new TypeError('x.map is not a function');
        },
      },
    };
    const a = await analyze(full, { mode: 'clean' }, boom);
    expect(a.unavailable).toContain('Crossref');
    expect(a.candidateSet.candidates.length).toBeGreaterThan(0);
  });

  it('offline: parsing, structure and formatting still work', async () => {
    const messy = '@inproceedings{k, title="A Study of GPU Kernels", author={Smith, John}, pages={10-20}, year={2024}}';
    const { a, ev } = await run(messy, {
      fail: {
        Crossref: 'NETWORK UNAVAILABLE',
        DBLP: 'NETWORK UNAVAILABLE',
        OpenAlex: 'NETWORK UNAVAILABLE',
        DataCite: 'NETWORK UNAVAILABLE',
      },
    });
    expect(a.input).toBeDefined();
    expect(a.structural.length).toBeGreaterThan(0);
    const fmt = ev.suggestions.filter((s) => s.category === 'format');
    expect(fmt.some((s) => s.field === 'pages')).toBe(true);
    expect(ev.suggestions.every((s) => s.category !== 'conflict')).toBe(true);
    expect(applySuggestions(messy, ev.suggestions).text).toBe(messy);
  });

  it('makes no network call when the entry does not parse', async () => {
    const sources = mockSources({ records: [cr] });
    const a = await analyze('@inproceedings{k, title={unclosed', { mode: 'clean' }, sources);
    expect(sources.calls).toEqual([]);
    expect(a.structural.some((c) => c.state === 'CONFLICT' || c.state === 'UNVERIFIED')).toBe(true);
  });
});

describe('disagreement between sources is surfaced, never silently resolved', () => {
  it('keeps both years visible and does not claim a verified year', async () => {
    const crOld = work('Crossref', {
      title: T,
      authors: AUTH,
      year: 2024,
      venue: 'Proceedings of the ACM Conference on Example Security',
      doi: '10.5555/1000001',
      type: 'inproceedings',
    });
    const dblpNew = work('DBLP', {
      title: T,
      authors: AUTH,
      year: 2025,
      venue: 'EXSEC',
      venueShort: 'EXSEC',
      doi: '10.5555/1000001',
      type: 'inproceedings',
    });
    const src = bib(
      `  title={${T}},\n  author={Smith, John and Doe, Jane},\n  booktitle={Proceedings of the ACM Conference on Example Security},\n  year={2025}`,
    );
    const { ev } = await run(src, { records: [crOld, dblpNew], search: { Crossref: [crOld], DBLP: [dblpNew] } });
    const yearSug = ev.suggestions.find((s) => s.field === 'year');
    if (yearSug) {
      // If a change is proposed at all it must be downgraded and carry both sources.
      expect(['POSSIBLE', 'LOW']).toContain(yearSug.confidence);
      expect(yearSug.sources.length).toBeGreaterThan(1);
      expect(yearSug.reason).toMatch(/disagree|differ/i);
    }
    const cmp = ev.comparisons.find((c) => c.field === 'year')!;
    expect(cmp.evidence.map((e) => e.source)).toEqual(expect.arrayContaining(['Crossref', 'DBLP']));
  });

  it('every suggestion carries an id, reason, evidence and an undecided state', async () => {
    const { ev } = await run(bib(`  title={${T}},\n  author={Smith, John and Doe, Jane},\n  year={2025}`), {
      records: [cr, dblp],
      search: { Crossref: [cr], DBLP: [dblp] },
    });
    const ids = new Set<string>();
    for (const s of ev.suggestions) {
      expect(s.id).toBeTruthy();
      expect(ids.has(s.id), `duplicate suggestion id ${s.id}`).toBe(false);
      ids.add(s.id);
      expect(s.reason.length).toBeGreaterThan(10);
      expect(s.accepted).toBeNull();
      expect(s.field).toBeTruthy();
      expect(['add', 'replace', 'format', 'rename', 'remove']).toContain(s.operation);
      if (s.category === 'conflict' || s.category === 'missing' || s.category === 'version')
        expect(s.sources.length, `${s.field} needs provenance`).toBeGreaterThan(0);
    }
  });

  it('never proposes deleting user metadata outside a version conversion', async () => {
    const withExtras = bib(
      `  title={${T}},\n  author={Smith, John and Doe, Jane},\n  year={2024},\n  note={Personal copy},\n  keywords={iot, security},\n  abstract={Long abstract here.}`,
    );
    const { ev } = await run(withExtras, { records: [cr, dblp], search: { Crossref: [cr], DBLP: [dblp] } });
    const removals = ev.suggestions.filter((s) => s.patch.kind === 'remove');
    expect(removals.every((s) => s.category === 'version')).toBe(true);
    const out = applySuggestions(
      withExtras,
      ev.suggestions.map((s) => ({ ...s, accepted: true })),
    );
    for (const f of ['note', 'keywords', 'abstract']) expect(out.text).toContain(f);
  });
});

describe('a contradicted DOI is never reused', () => {
  it('does not offer a URL built from a DOI that belongs to another work', async () => {
    const wrong = work('Crossref', {
      title: 'Lattice Models of Protein Folding',
      authors: ['Ana Ruiz'],
      year: 2019,
      doi: '10.5555/9999999',
      type: 'article',
    });
    const src = bib(`  title={${T}},\n  author={Smith, John and Doe, Jane},\n  year={2024},\n  doi={10.5555/9999999}`);
    const { ev } = await run(src, { records: [wrong, cr, dblp], search: { Crossref: [cr], DBLP: [dblp] } });
    expect(ev.checks.find((c) => c.id === 'doi-identity')?.state).toBe('CONFLICT');
    const urls = ev.suggestions.filter((s) => s.field === 'url');
    expect(urls.map((s) => s.suggestedValue)).not.toContain('https://doi.org/10.5555/9999999');
    // the DOI correction itself is still offered, with the conflict visible
    expect(ev.suggestions.some((s) => s.field === 'doi' && s.suggestedValue === '10.5555/1000001')).toBe(true);
  });

  it('still links the DOI when the entry and the record agree', async () => {
    const src = bib(`  title={${T}},\n  author={Smith, John and Doe, Jane},\n  year={2024},\n  doi={10.5555/1000001}`);
    const { ev } = await run(src, { records: [cr, dblp], search: { Crossref: [cr], DBLP: [dblp] } });
    expect(ev.suggestions.some((s) => s.field === 'url' && s.suggestedValue === 'https://doi.org/10.5555/1000001')).toBe(true);
  });
});

describe('ambiguity is preferred over a guess', () => {
  const a1 = work('Crossref', {
    title: 'Neural Attention Models',
    authors: ['Ana Ruiz'],
    year: 2021,
    venue: 'Journal of Examples',
    doi: '10.5555/A',
    type: 'article',
  });
  const a2 = work('Crossref', {
    title: 'Neural Attention Models',
    authors: ['Bo Chen'],
    year: 2021,
    venue: 'Proc of Other',
    doi: '10.5555/B',
    type: 'inproceedings',
  });

  it('two plausible works with a sparse citation produce no metadata suggestions', async () => {
    const src = '@article{k, title={Neural Attention Models}, year={2021}}';
    const { a, ev } = await run(src, { records: [a1, a2], search: { Crossref: [a1, a2] } });
    expect(a.candidateSet.ambiguous).toBe(true);
    expect(a.candidateSet.selectedId).toBeNull();
    expect(ev.suggestions.filter((s) => s.category === 'conflict' || s.category === 'missing')).toEqual([]);
    expect(a.candidateSet.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('a decisive author list resolves the ambiguity', async () => {
    const src = '@article{k, title={Neural Attention Models}, author={Ruiz, Ana}, year={2021}, journal={Journal of Examples}}';
    const { a, cand } = await run(src, { records: [a1, a2], search: { Crossref: [a1, a2] } });
    expect(a.candidateSet.ambiguous).toBe(false);
    expect(cand?.work.doi).toBe('10.5555/A');
  });

  it('no candidate at all is reported as unverified, with no suggestions invented', async () => {
    const src = '@article{k, title={An Entirely Unknown Paper About Nothing}, author={Nobody, A}, year={2019}}';
    const { a, ev } = await run(src, { records: [] });
    expect(a.candidateSet.candidates).toEqual([]);
    expect(ev.checks.find((c) => c.id === 'match')?.state).toBe('UNVERIFIED');
    expect(ev.suggestions.filter((s) => s.category === 'conflict' || s.category === 'missing')).toEqual([]);
  });

  it('a single weak candidate is never treated as verified', async () => {
    const weak = work('Crossref', {
      title: 'Attention Models for Vision',
      authors: ['Zed Quinn'],
      year: 2015,
      doi: '10.5555/W',
      type: 'article',
    });
    const src = '@article{k, title={Neural Attention Models}, author={Ruiz, Ana}, year={2021}}';
    const { a, cand } = await run(src, { records: [weak], search: { Crossref: [weak] } });
    expect(cand?.score.state ?? 'UNVERIFIED').not.toBe('VERIFIED');
    if (cand) expect(cand.score.confidence === 'VERY HIGH').toBe(false);
    expect(a.candidateSet.candidates.every((c) => c.score.total < 0.95)).toBe(true);
  });
});

describe('DOI discovery degrades with the evidence', () => {
  const variants: [string, string][] = [
    [
      'title, authors, year and venue',
      `  title={${T}},\n  author={Smith, John and Doe, Jane},\n  booktitle={Proceedings of the ACM Conference on Example Security},\n  year={2024}`,
    ],
    ['title, authors and year', `  title={${T}},\n  author={Smith, John and Doe, Jane},\n  year={2024}`],
    ['title and abbreviated authors', `  title={${T}},\n  author={Smith, J. and Doe, J.}`],
    ['title and year only', `  title={${T}},\n  year={2024}`],
    ['title only', `  title={${T}}`],
  ];
  it.each(variants)('%s', async (_name, fields) => {
    const { cand, ev } = await run(bib(fields), { records: [cr, dblp], search: { Crossref: [cr], DBLP: [dblp] } });
    const doiSug = ev.suggestions.find((s) => s.field === 'doi');
    if (doiSug) {
      expect(doiSug.suggestedValue).toBe('10.5555/1000001'); // never a different DOI
      expect(doiSug.sources.length).toBeGreaterThan(0);
    }
    if (cand) expect(cand.score.total).toBeLessThanOrEqual(1);
  });

  it('richer evidence scores at least as high as sparser evidence', async () => {
    const scores: number[] = [];
    for (const [, fields] of variants) {
      const { cand } = await run(bib(fields), { records: [cr, dblp], search: { Crossref: [cr], DBLP: [dblp] } });
      scores.push(cand?.score.total ?? 0);
    }
    expect(scores[0]).toBeGreaterThanOrEqual(scores[4]);
    expect(scores[4]).toBeLessThan(0.95); // a bare title never reaches VERIFIED
  });
});

describe('adversarial DOI discovery', () => {
  const cases: [string, string, MockData][] = [
    [
      'same title, different authors',
      `@inproceedings{k, title={${T}}, author={Ruiz, Ana and Chen, Bo}, year={2024}}`,
      { records: [cr], search: { Crossref: [cr] } },
    ],
    [
      'same title, different year',
      `@inproceedings{k, title={${T}}, author={Smith, John and Doe, Jane}, year={2019}}`,
      { records: [cr], search: { Crossref: [cr] } },
    ],
    [
      'same first author, similar title, different venue',
      `@inproceedings{k, title={AI for IoT Security in Homes}, author={Smith, John}, booktitle={Workshop on Something Else}, year={2024}}`,
      { records: [cr], search: { Crossref: [cr] } },
    ],
    [
      'generic title shared by two works',
      '@article{k, title={A Survey}, year={2020}}',
      {
        records: [
          work('Crossref', { title: 'A Survey', authors: ['X Y'], year: 2020, doi: '10.5555/G1', type: 'article' }),
          work('Crossref', { title: 'A Survey', authors: ['P Q'], year: 2020, doi: '10.5555/G2', type: 'article' }),
        ],
        search: {
          Crossref: [
            work('Crossref', { title: 'A Survey', authors: ['X Y'], year: 2020, doi: '10.5555/G1', type: 'article' }),
            work('Crossref', { title: 'A Survey', authors: ['P Q'], year: 2020, doi: '10.5555/G2', type: 'article' }),
          ],
        },
      },
    ],
    [
      'erratum for the original paper',
      `@article{k, title={${T}}, author={Smith, John and Doe, Jane}, year={2024}}`,
      {
        records: [
          work('Crossref', {
            title: `Erratum: ${T}`,
            authors: ['John Smith', 'Jane Doe'],
            year: 2024,
            doi: '10.5555/ERR',
            type: 'article',
          }),
        ],
        search: {
          Crossref: [
            work('Crossref', {
              title: `Erratum: ${T}`,
              authors: ['John Smith', 'Jane Doe'],
              year: 2024,
              doi: '10.5555/ERR',
              type: 'article',
            }),
          ],
        },
      },
    ],
  ];
  it.each(cases)('%s: no confident correction', async (_n, src, data) => {
    const { cand, ev } = await run(src, data);
    const confident = ev.suggestions.filter(
      (s) => (s.category === 'conflict' || s.category === 'missing') && (s.confidence === 'HIGH' || s.confidence === 'VERY HIGH'),
    );
    expect(
      confident.map((s) => `${s.field}=${s.suggestedValue}`),
      'confident corrections on adversarial input',
    ).toEqual([]);
    expect(cand?.score.state === 'VERIFIED').toBe(false);
  });
});

describe('verify mode is not enrichment', () => {
  it('does not add missing metadata or formatting', async () => {
    const src = bib(`  title={${T}},\n  author={Smith, John and Doe, Jane},\n  year={2024},\n  pages={120-131}`);
    const { ev } = await run(src, { records: [cr, dblp], search: { Crossref: [cr], DBLP: [dblp] } }, 'verify');
    expect(ev.suggestions.filter((s) => s.category === 'missing' || s.category === 'format' || s.category === 'key')).toEqual([]);
  });
  it('still reports a wrong DOI', async () => {
    const wrong = work('Crossref', {
      title: 'Protein Folding with Lattice Models',
      authors: ['Ana Ruiz'],
      year: 2019,
      doi: '10.5555/9999999',
      type: 'article',
    });
    const src = bib(`  title={${T}},\n  author={Smith, John and Doe, Jane},\n  year={2024},\n  doi={10.5555/9999999}`);
    const { ev } = await run(src, { records: [wrong, cr, dblp], search: { Crossref: [cr], DBLP: [dblp] } }, 'verify');
    expect(ev.checks.find((c) => c.id === 'doi-identity')?.state).toBe('CONFLICT');
  });
});
