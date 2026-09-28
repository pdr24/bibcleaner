import { latexToUnicode, unicodeToLatex, stripMarkup } from '../../core/normalize/latex';
import { normalizeForComparison, titleSimilarity } from '../../core/normalize/text';
import { parseAuthorField, parseName, compareAuthorLists, formatAuthorList } from '../../core/normalize/authors';
import { normalizePages, pagesEquivalent } from '../../core/normalize/pages';
import { venueSimilarity, venueAbbrev } from '../../core/normalize/venue';

describe('LaTeX decoding', () => {
  it.each([
    ['M{\\"u}ller', 'Müller'],
    ['M\\"uller', 'Müller'],
    ['Erd\\H{o}s', 'Erdős'],
    ["{\\'E}cole", 'École'],
    ['Stra{\\ss}e', 'Straße'],
    ['Dijkstra \\& Knuth', 'Dijkstra & Knuth'],
    ['Pages 1--10', 'Pages 1–10'],
    ['\\emph{Deep} Learning', 'Deep Learning'],
    ['\\c{C}elik', 'Çelik'],
  ])('%s -> %s', (a, b) => expect(latexToUnicode(a)).toBe(b));
  it('encodes specials and accents', () => {
    expect(unicodeToLatex('R&D 50% #1 a_b')).toBe('R\\&D 50\\% \\#1 a\\_b');
    expect(unicodeToLatex('Müller')).toBe('M{\\"u}ller');
    expect(latexToUnicode(unicodeToLatex('Çelik Erdős École naïve'))).toBe('Çelik Erdős École naïve');
  });
  it('strips Crossref markup', () => expect(stripMarkup('Learning <i>fast</i> &amp; well').text).toBe('Learning fast & well'));
});

describe('title normalization', () => {
  it('ignores case, braces, LaTeX, dashes and punctuation', () => {
    expect(normalizeForComparison('Using {AI} for {IoT}---Security!')).toBe(normalizeForComparison('using ai for iot — security'));
  });
  it('scores identical titles 1 and different titles low', () => {
    expect(titleSimilarity('Using {AI} for IoT Security', 'Using AI for IoT security')).toBe(1);
    expect(titleSimilarity('Attention Is All You Need', 'Graph Neural Networks for Molecules')).toBeLessThan(0.4);
  });
  it('tolerates a missing subtitle', () => {
    expect(
      titleSimilarity('Scratch Programming in Middle Schools', 'Scratch Programming in Middle Schools: A Longitudinal Study'),
    ).toBeGreaterThanOrEqual(0.9);
  });
});

describe('authors', () => {
  it.each([
    ['John Smith', 'Smith', 'John'],
    ['Smith, John', 'Smith', 'John'],
    ['J. Smith', 'Smith', 'J.'],
    ['Smith, J. A.', 'Smith', 'J. A.'],
    ['Ludwig van Beethoven', 'van Beethoven', 'Ludwig'],
    ['{World Health Organization}', 'World Health Organization', ''],
    ['Smith, Jr., John', 'Smith', 'John'],
  ])('parses %s', (raw, family, given) => {
    const a = parseName(raw);
    expect(a.family).toBe(family);
    expect(a.given).toBe(given);
  });
  it('detects "and others"', () => expect(parseAuthorField('A and B and others').truncated).toBe(true));
  it('does not split "and" inside braces', () => expect(parseAuthorField('{Barnes and Noble} and Jane Doe').authors.length).toBe(2));
  it('matches abbreviated names', () => {
    const a = parseAuthorField('Smith, J. A. and Doe, J.').authors;
    const b = parseAuthorField('John A. Smith and Jane Doe').authors;
    const c = compareAuthorLists(a, b);
    expect(c.score).toBeGreaterThanOrEqual(0.95);
    expect(c.otherHasFullerNames).toBe(true);
  });
  it('does not match people who only share a surname', () => {
    const a = parseAuthorField('John Smith').authors;
    const b = parseAuthorField('Mary Smith').authors;
    expect(compareAuthorLists(a, b).score).toBeLessThan(0.5);
  });
  it('handles accents across encodings', () => {
    const a = parseAuthorField('M{\\"u}ller, Hans').authors;
    const b = parseAuthorField('Hans Müller').authors;
    expect(compareAuthorLists(a, b).identical).toBe(true);
  });
  it('formats consistently', () => {
    expect(formatAuthorList(parseAuthorField('John Smith and Doe, Jane').authors, 'last-first', false)).toBe('Smith, John and Doe, Jane');
  });
});

describe('pages and venues', () => {
  it('normalises page ranges', () => {
    expect(normalizePages('123-134')).toBe('123--134');
    expect(normalizePages('123 – 134')).toBe('123--134');
    expect(normalizePages('e1234')).toBe('e1234');
    expect(pagesEquivalent('1234-56', '1234--1256')).toBe(true);
  });
  it('matches venue acronyms to full names', () => {
    expect(venueSimilarity('CHI', 'Proceedings of the 2024 CHI Conference on Human Factors in Computing Systems')).toBeGreaterThanOrEqual(
      0.85,
    );
    expect(venueSimilarity('CHI', 'ICSE')).toBeLessThan(0.5);
    expect(venueAbbrev("Proceedings of the 2024 ACM SIGSAC Conference on Computer and Communications Security (CCS '24)")).toBe('ccs');
  });
});
