/**
 * QA pass: the confidence engine. Determinism, weight behaviour, threshold
 * boundaries, and — most importantly — critical contradictions overriding a
 * high numerical score.
 */
import { confidenceFor, sameRecord, sameWork, scoreCandidate, yearScore } from '../../core/confidence/score';
import { THRESHOLDS, WEIGHTS } from '../../core/confidence/config';
import type { Author, Work } from '../../core/models/types';

const A = (s: string): Author => {
  const parts = s.split(' ');
  return { family: parts.pop()!, given: parts.join(' ') };
};
const W = (o: Omit<Partial<Work>, 'authors'> & { authors?: string[] }): Work =>
  ({ ...o, authors: (o.authors ?? []).map(A), sourceRecords: [] }) as Work;

const base = {
  title: 'Using AI for IoT Security in Smart Homes',
  authors: ['John Smith', 'Jane Doe'],
  year: 2024,
  venue: 'ACM Conference on Example Security',
  publisher: 'ACM',
};

describe('determinism and shape', () => {
  it('produces identical output for identical evidence', () => {
    const a = scoreCandidate(W(base), W(base));
    for (let i = 0; i < 25; i++) expect(scoreCandidate(W(base), W(base))).toEqual(a);
  });
  it('weights sum to one', () => {
    expect(Object.values(WEIGHTS).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 10);
  });
  it('records which components were actually compared', () => {
    const s = scoreCandidate(W({ title: 'T', authors: ['John Smith'] }), W({ title: 'T', authors: ['John Smith'], year: 2020 }));
    expect(Object.keys(s.components).sort()).toEqual(['authors', 'title']);
  });
  it('an identical record is VERIFIED', () => {
    const s = scoreCandidate(W(base), W(base));
    expect(s.state).toBe('VERIFIED');
    expect(s.confidence).toBe('VERY HIGH');
    expect(s.criticalContradictions).toEqual([]);
  });
});

describe('sparse evidence cannot reach high confidence', () => {
  it('title alone is capped below HIGH', () => {
    const s = scoreCandidate(W({ title: base.title }), W({ title: base.title }));
    expect(s.total).toBeLessThan(THRESHOLDS.high);
    expect(s.state).not.toBe('VERIFIED');
  });
  it('a generic title alone does not become a match', () => {
    const s = scoreCandidate(W({ title: 'A Survey' }), W({ title: 'A Survey' }));
    expect(s.confidence === 'VERY HIGH' || s.confidence === 'HIGH').toBe(false);
  });
  it('unavailable fields are excluded rather than scored as disagreement', () => {
    const full = scoreCandidate(W(base), W(base));
    const sparse = scoreCandidate(W({ title: base.title, authors: base.authors }), W(base));
    expect(sparse.components.venue).toBeUndefined();
    expect(sparse.total).toBeGreaterThan(THRESHOLDS.possible);
    expect(full.total).toBeGreaterThanOrEqual(sparse.total);
  });
});

describe('critical contradictions override the score', () => {
  it('excellent title and venue with the wrong authors is never VERIFIED', () => {
    const s = scoreCandidate(W(base), W({ ...base, authors: ['Ana Ruiz', 'Bob Stone'] }));
    expect(s.criticalContradictions.length).toBeGreaterThan(0);
    expect(s.state).not.toBe('VERIFIED');
    expect(['POSSIBLE', 'LOW']).toContain(s.confidence);
  });
  it('a matching DOI on a different paper is a CONFLICT, not a verification', () => {
    const s = scoreCandidate(
      W({ ...base, doi: '10.5555/1' }),
      W({ title: 'Lattice Models of Protein Folding', authors: ['Ana Ruiz'], year: 2019, doi: '10.5555/1' }),
    );
    expect(s.identifierMatch).toBe(true);
    expect(s.state).toBe('CONFLICT');
    expect(s.criticalContradictions.join(' ')).toMatch(/different title/i);
  });
  it('a first-author mismatch is surfaced even when the rest matches', () => {
    const s = scoreCandidate(W(base), W({ ...base, authors: ['Jane Doe', 'John Smith'] }));
    expect(s.criticalContradictions.join(' ')).toMatch(/first author/i);
    expect(s.state).not.toBe('VERIFIED');
  });
  it('a year gap greater than one is critical; one year is not', () => {
    expect(scoreCandidate(W(base), W({ ...base, year: 2021 })).criticalContradictions.join(' ')).toMatch(/years differ/i);
    expect(scoreCandidate(W(base), W({ ...base, year: 2023 })).criticalContradictions).toEqual([]);
  });
  it('different venue and different year reads as another version, not a match', () => {
    const s = scoreCandidate(W(base), W({ ...base, year: 2025, venue: 'Journal of Unrelated Studies' }));
    expect(s.criticalContradictions.length).toBeGreaterThan(0);
    expect(s.state).not.toBe('VERIFIED');
  });
  it('version comparison suppresses the year and venue contradictions on purpose', () => {
    const s = scoreCandidate(W(base), W({ ...base, year: 2026, venue: 'Journal of Examples' }), { versionComparison: true });
    expect(s.criticalContradictions.join(' ')).not.toMatch(/years differ|Different venue/);
  });
  it('identifier supersession never applies when contradictions exist', () => {
    const s = scoreCandidate(W({ ...base, doi: '10.5555/1' }), W({ ...base, doi: '10.5555/1', authors: ['Ana Ruiz', 'Bo Chen'] }));
    expect(s.total).toBeLessThan(0.97);
    expect(s.state).not.toBe('VERIFIED');
  });
});

describe('threshold boundaries', () => {
  it.each([
    [THRESHOLDS.veryHigh, 'VERY HIGH'],
    [THRESHOLDS.veryHigh - 0.001, 'HIGH'],
    [THRESHOLDS.high, 'HIGH'],
    [THRESHOLDS.high - 0.001, 'POSSIBLE'],
    [THRESHOLDS.possible, 'POSSIBLE'],
    [THRESHOLDS.possible - 0.001, 'LOW'],
    [0, 'LOW'],
    [1, 'VERY HIGH'],
  ])('score %s maps to %s', (score, label) => expect(confidenceFor(score as number)).toBe(label));
  it('year scoring is exact, off-by-one, or nothing', () => {
    expect(yearScore(2024, 2024)).toBe(1);
    expect(yearScore(2024, 2023)).toBe(0.6);
    expect(yearScore(2024, 2020)).toBe(0);
    expect(yearScore(undefined, 2024)).toBeUndefined();
    expect(yearScore(2024, undefined)).toBeUndefined();
  });
  it('scores are bounded to [0,1]', () => {
    for (const cand of [W(base), W({ title: 'x' }), W({ ...base, year: 1900 }), W({ ...base, authors: [] })]) {
      const s = scoreCandidate(W(base), cand);
      expect(s.total).toBeGreaterThanOrEqual(0);
      expect(s.total).toBeLessThanOrEqual(1);
    }
  });
});

describe('grouping records', () => {
  it('same DOI means same work, whatever the strings say', () => {
    expect(sameWork(W({ title: 'A', doi: '10.5555/x' }), W({ title: 'Completely different', doi: '10.5555/X' }))).toBe(true);
  });
  it('same title with different first authors is not the same work', () => {
    expect(sameWork(W({ title: base.title, authors: base.authors }), W({ title: base.title, authors: ['Ana Ruiz', 'Bo Chen'] }))).toBe(
      false,
    );
  });
  it('a preprint and its published version are the same work but not the same record', () => {
    const pre = W({ title: base.title, authors: base.authors, year: 2023, isPreprint: true, venue: 'arXiv' });
    const pub = W({ title: base.title, authors: base.authors, year: 2024, isPreprint: false, venue: base.venue });
    expect(sameWork(pre, pub)).toBe(true);
    expect(sameRecord(pre, pub)).toBe(false);
  });
  it('unparseable DOI strings never group two records together', () => {
    expect(sameWork(W({ title: 'A', doi: 'not-a-doi' }), W({ title: 'B', doi: 'not-a-doi' }))).toBe(false);
  });
  it('different DOIs are never the same record', () => {
    expect(sameRecord(W({ title: 'T', doi: '10.5555/a' }), W({ title: 'T', doi: '10.5555/b' }))).toBe(false);
  });
});
