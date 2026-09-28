import type { Suggestion } from '../../core/models/types';
import { judge, report, type EntryOutcome } from '../../scripts/eval/metrics';

const sg = (field: string, value: string, over: Partial<Suggestion> = {}): Suggestion => ({
  id: field,
  field,
  operation: 'add',
  category: 'missing',
  patch: { kind: 'set', value },
  title: '',
  suggestedValue: value,
  confidence: 'HIGH',
  reason: '',
  sources: [],
  accepted: null,
  ...over,
});

describe('acceptance metrics', () => {
  it('judges suggestions against verified truth', () => {
    expect(judge(sg('doi', '10.5555/ABC'), { doi: '10.5555/abc' })).toBe('correct');
    expect(judge(sg('doi', '10.5555/x'), { doi: null })).toBe('incorrect');
    expect(judge(sg('year', '2024'), { year: 2023 })).toBe('incorrect');
    expect(judge(sg('pages', '120--131'), { pages: '120-31' })).toBe('correct');
    expect(judge(sg('title', 'x', { category: 'format' }), { title: 'y' })).toBe('unjudged');
  });
  it('reports the release-blocking metric', () => {
    const out: EntryOutcome[] = [
      {
        id: 'a',
        inputHadDoi: false,
        truth: { doi: '10.5555/a' },
        ambiguousPredicted: false,
        top1: true,
        score: 0.97,
        judged: [{ s: sg('doi', '10.5555/a'), verdict: 'correct' }],
      },
      {
        id: 'b',
        inputHadDoi: false,
        truth: { doi: '10.5555/b' },
        ambiguousPredicted: false,
        top1: false,
        score: 0.9,
        judged: [{ s: sg('doi', '10.5555/z'), verdict: 'incorrect' }],
      },
    ];
    const r = report(out);
    expect(r.highConfidenceIncorrect).toEqual([{ id: 'b', field: 'doi', value: '10.5555/z' }]);
    expect(r.lines.join('\n')).toContain('DOI discovery precision: 50.0% (1/2)');
  });
});
