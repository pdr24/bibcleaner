import { corpus } from '../fixtures/citations/corpus';
import { mockSources } from '../fixtures/mockSources';
import { analyze } from '../../core/verification/pipeline';
import { evaluate, DEFAULT_EVAL_SETTINGS } from '../../core/verification/evaluate';
import { setKV } from '../../core/net/cache';

beforeAll(() => {
  // Isolate from any cache between fixtures.
  setKV({ get: async () => undefined, set: async () => {}, clear: async () => {} });
});

describe.each(corpus)('golden corpus: $name', (fx) => {
  it('behaves as specified', async () => {
    const sources = mockSources(fx.data);
    const mode = fx.mode ?? 'clean';
    const a = await analyze(fx.bib, { mode }, sources);
    const cs = a.candidateSet;
    const selected = cs.candidates.find((c) => c.id === cs.selectedId) ?? null;
    const ev = evaluate(a.input!, selected, { ...DEFAULT_EVAL_SETTINGS, mode }, undefined, a.doiChecks);
    const e = fx.expect;

    if (e.selectedTitle !== undefined) expect(selected?.work.title ?? null).toBe(e.selectedTitle);
    if (e.ambiguous !== undefined) expect(cs.ambiguous).toBe(e.ambiguous);
    if (e.versions) expect(cs.versions).toBeDefined();
    for (const [id, state] of Object.entries(e.checks ?? {}))
      expect({ id, state: ev.checks.find((c) => c.id === id)?.state }).toEqual({ id, state });
    for (const [f, state] of Object.entries(e.fields ?? {}))
      expect({ f, state: ev.comparisons.find((c) => c.field === f)?.status }).toEqual({ f, state });
    for (const s of e.suggest ?? []) {
      const hit = ev.suggestions.find(
        (x) =>
          x.field === s.field &&
          (s.value === undefined || x.suggestedValue === s.value) &&
          (s.category === undefined || x.category === s.category),
      );
      expect(
        hit,
        `expected suggestion ${JSON.stringify(s)}; got ${JSON.stringify(ev.suggestions.map((x) => [x.field, x.suggestedValue, x.category]))}`,
      ).toBeDefined();
    }
    for (const s of e.notSuggest ?? []) {
      const hit = ev.suggestions.find((x) => x.field === s.field && (s.value === undefined || x.suggestedValue === s.value));
      expect(hit, `unexpected suggestion ${JSON.stringify(s)}`).toBeUndefined();
    }
    if (e.unavailable) expect(a.unavailable.sort()).toEqual([...e.unavailable].sort());
    if (e.noConfidentCorrections) {
      const bad = ev.suggestions.filter(
        (x) => x.category !== 'format' && x.category !== 'key' && (x.confidence === 'HIGH' || x.confidence === 'VERY HIGH'),
      );
      expect(bad, JSON.stringify(bad.map((b) => [b.field, b.suggestedValue, b.confidence]))).toEqual([]);
      expect(selected?.score.state === 'VERIFIED').toBe(false);
    }
    // Invariant: nothing is pre-accepted.
    expect(ev.suggestions.every((s) => s.accepted === null)).toBe(true);
  });
});

describe('pipeline invariants', () => {
  it('makes no network calls for unparseable input', async () => {
    const s = mockSources({});
    const a = await analyze('@article{k, title={oops', { mode: 'clean' }, s);
    expect(a.entry).toBeUndefined();
    expect(s.calls).toEqual([]);
  });
  it('stops discovery when the DOI record is a strong match (verify mode)', async () => {
    const fx = corpus[0];
    const s = mockSources(fx.data);
    await analyze(fx.bib, { mode: 'verify' }, s);
    expect(s.calls.filter((c) => c.includes('search'))).toEqual([]);
  });
});
