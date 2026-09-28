import type { Suggestion } from '../../core/models/types';
import { acceptAll, carryDecisions, counts, decide, rejectAll, setVersionChanges } from '../../ui/review/review';

const s = (id: string, over: Partial<Suggestion> = {}): Suggestion => ({
  id,
  field: id.split('-')[0],
  operation: 'replace',
  category: 'conflict',
  patch: { kind: 'set', value: id },
  title: id,
  suggestedValue: id,
  confidence: 'HIGH',
  reason: 'r',
  sources: [],
  accepted: null,
  ...over,
});

describe('review state', () => {
  it('starts with nothing accepted', () => {
    expect(counts([s('a'), s('b')])).toEqual({ total: 2, accepted: 0, rejected: 0, undecided: 2 });
  });
  it('accepting one alternative rejects the others in its group', () => {
    const list = [s('author-0', { group: 'author' }), s('author-1', { group: 'author', suggestedValue: 'x' })];
    const a = decide(list, 'author-0', true);
    const b = decide(a, 'author-1', true);
    expect(b.map((x) => x.accepted)).toEqual([false, true]);
  });
  it('accept all skips key and version changes and takes one alternative per group', () => {
    const list = [
      s('year-0'),
      s('KEY-1', { category: 'key' }),
      s('doi-2', { category: 'version' }),
      s('author-3', { group: 'g' }),
      s('author-4', { group: 'g', suggestedValue: 'y' }),
    ];
    const out = acceptAll(list);
    expect(out.map((x) => x.accepted)).toEqual([true, null, null, true, null]);
  });
  it('accept all respects explicit rejections', () => {
    const out = acceptAll(decide([s('year-0'), s('doi-1')], 'year-0', false));
    expect(out.map((x) => x.accepted)).toEqual([false, true]);
  });
  it('reject all rejects everything', () => {
    expect(rejectAll([s('a', { accepted: true }), s('b', { category: 'key' })]).every((x) => x.accepted === false)).toBe(true);
  });
  it('version changes are approved together only on request', () => {
    const out = setVersionChanges([s('doi-0', { category: 'version' }), s('year-1')], true);
    expect(out.map((x) => x.accepted)).toEqual([true, null]);
  });
  it('carries decisions across regenerated ids', () => {
    const prev = [s('year-0', { accepted: true })];
    const next = [s('year-5', { suggestedValue: 'year-0', patch: { kind: 'set', value: 'year-0' } })];
    expect(carryDecisions(prev, next)[0].accepted).toBe(true);
  });
});
