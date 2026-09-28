import { parseDoi, sameDoi, findDoiInText, doiUrl } from '../../core/normalize/doi';

describe('DOI normalization', () => {
  const forms = [
    '10.1145/1234567.1234568',
    'doi:10.1145/1234567.1234568',
    'https://doi.org/10.1145/1234567.1234568',
    'http://dx.doi.org/10.1145/1234567.1234568',
    'DOI: 10.1145/1234567.1234568',
  ];
  it.each(forms)('normalises %s', (f) => expect(parseDoi(f)?.doi).toBe('10.1145/1234567.1234568'));
  it('flags non-canonical forms', () => {
    expect(parseDoi('10.1145/1')!.wasCanonical).toBe(true);
    expect(parseDoi('https://doi.org/10.1145/1')!.wasCanonical).toBe(false);
  });
  it('is case-insensitive for comparison', () => expect(sameDoi('10.1000/ABC', 'https://doi.org/10.1000/abc')).toBe(true));
  it('rejects non-DOIs', () => {
    expect(parseDoi('hello')).toBeNull();
    expect(parseDoi('11.1234/x')).toBeNull();
    expect(parseDoi('10.12/x')).toBeNull();
  });
  it('unescapes LaTeX underscores', () => expect(parseDoi('10.1000/a\\_b')?.doi).toBe('10.1000/a_b'));
  it('strips trailing punctuation', () => expect(parseDoi('10.1000/abc.')?.doi).toBe('10.1000/abc'));
  it('finds a DOI in a URL', () => expect(findDoiInText('https://dl.acm.org/doi/10.1145/3544548.3581388')).toBe('10.1145/3544548.3581388'));
  it('builds doi.org URLs', () => expect(doiUrl('10.1000/a<b')).toBe('https://doi.org/10.1000/a%3Cb'));
});
