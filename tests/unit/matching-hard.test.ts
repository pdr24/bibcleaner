/**
 * QA pass: normalisation used for comparison — titles, authors, venues.
 * Two properties matter: comparison must be tolerant of presentation, and it
 * must never merge genuinely different works.
 */
import { foldDiacritics, normalizeForComparison, titleSimilarity, tokenSimilarity, tokens } from '../../core/normalize/text';
import { latexToUnicode, stripMarkup, unicodeToLatex } from '../../core/normalize/latex';
import { compareAuthorLists, formatAuthorList, parseAuthorField, parseName } from '../../core/normalize/authors';
import { isPreprintVenue, venueAbbrev, venueSimilarity } from '../../core/normalize/venue';
import { normalizePages, pagesEquivalent } from '../../core/normalize/pages';

const sim = (a: string, b: string) => titleSimilarity(a, b);
const authors = (s: string) => parseAuthorField(s).authors;
const cmp = (a: string, b: string) => compareAuthorLists(authors(a), authors(b));

describe('title normalisation for comparison', () => {
  const T = 'Deep Learning for IoT: A Survey';
  it.each([
    'deep learning for iot: a survey',
    'Deep  Learning   for IoT:  A Survey',
    'Deep Learning for {IoT}: A Survey',
    'Deep Learning for IoT — A Survey',
    'Deep Learning for IoT - A Survey',
    'Deep Learning for IoT&#58; A Survey'.replace('&#58;', ':'),
  ])('treats %j as the same title', (v) => expect(sim(T, v)).toBeGreaterThan(0.92));

  it('handles LaTeX commands, Unicode and HTML entities from APIs', () => {
    expect(sim('Na\\"{\\i}ve Bayes for Caf\\\'e Reviews', 'Naïve Bayes for Café Reviews')).toBeGreaterThan(0.95);
    expect(stripMarkup('Deep <i>Learning</i> &amp; Beyond').text).toBe('Deep Learning & Beyond');
    expect(sim('α-Expansion for Graph Cuts', 'α-Expansion for Graph Cuts')).toBe(1);
  });
  it('tolerates a missing subtitle but not a different paper', () => {
    expect(sim('Deep Learning for IoT', T)).toBeGreaterThan(0.8);
    expect(sim('Shallow Learning for Robotics', T)).toBeLessThan(0.6);
  });
  it('does not equate different papers that share common words', () => {
    expect(sim('A Survey of Machine Learning', 'A Survey of Deep Reinforcement Learning in Robotics')).toBeLessThan(0.85);
    expect(sim('Attention Is All You Need', 'Attention Is Not All You Need')).toBeLessThan(0.95);
  });
  it('normalisation is idempotent and does not mutate its input', () => {
    const raw = '  The {Quick}  Brown Fox: A Study  ';
    const once = normalizeForComparison(raw);
    expect(normalizeForComparison(once)).toBe(once);
    expect(raw).toBe('  The {Quick}  Brown Fox: A Study  ');
    expect(foldDiacritics(foldDiacritics('Müller'))).toBe(foldDiacritics('Müller'));
  });
  it('LaTeX conversion round-trips accents without losing characters', () => {
    for (const s of ['Müller', 'Pérez', 'Łukasz', 'Göran Östberg', 'François']) {
      expect(latexToUnicode(unicodeToLatex(s, { accents: true }))).toBe(s);
    }
  });
});

describe('author matching', () => {
  it.each(['John Smith', 'Smith, John', 'J. Smith', 'Smith, J.', 'John A. Smith', 'Smith, John A.'])(
    'parses %j to the same surname',
    (s) => {
      expect(parseName(s).family).toBe('Smith');
    },
  );
  it('initials match full given names but a different given name does not', () => {
    expect(cmp('Smith, John', 'Smith, J.').score).toBeGreaterThan(0.85);
    expect(cmp('Smith, John', 'Smith, Jane').score).toBeLessThan(0.85);
  });
  it('handles particles, compound and hyphenated surnames', () => {
    expect(parseName('van der Berg, Ana').family).toBe('van der Berg');
    expect(parseName('Ana van der Berg').family).toBe('van der Berg');
    expect(parseName('García-López, María').family).toBe('García-López');
    expect(cmp('van der Berg, Ana', 'Ana van der Berg').score).toBeGreaterThan(0.9);
  });
  it('handles suffixes and literal organisation authors', () => {
    expect(parseName('King, Jr., Martin L.').family).toContain('King');
    expect(parseName('{The LLVM Project}').literal).toBe('The LLVM Project');
  });
  it('LaTeX-accented and Unicode spellings of the same name match', () => {
    expect(cmp('M{\\"u}ller, Hans', 'Müller, Hans').score).toBeGreaterThan(0.95);
  });
  it('reordered authors are detected as an ordering difference, not as a different list', () => {
    const c = cmp('Smith, John and Doe, Jane', 'Doe, Jane and Smith, John');
    expect(c.overlap).toBe(1);
    expect(c.firstAuthorMatch).toBe(false);
  });
  it('truncated lists ("and others") do not count as a mismatch', () => {
    const f = parseAuthorField('Smith, John and others');
    expect(f.truncated).toBe(true);
    const c = compareAuthorLists(f.authors, authors('Smith, John and Doe, Jane and Roe, Ann'), true);
    expect(c.score).toBeGreaterThan(0.85);
  });
  it('a completely different author list scores low', () => {
    expect(cmp('Smith, John and Doe, Jane', 'Ruiz, Ana and Chen, Bo').score).toBeLessThan(0.3);
  });
  it('shared surnames with different given names are not the same people', () => {
    expect(cmp('Smith, John', 'Smith, Mary').score).toBeLessThan(0.85);
  });
  it('extra authors reduce the score without destroying it', () => {
    const c = cmp('Smith, John and Doe, Jane', 'Smith, John and Doe, Jane and Roe, Ann and Poe, Ed');
    expect(c.score).toBeLessThan(1);
    // Two of four authors present: conservative, but not treated as a different paper.
    expect(c.score).toBeGreaterThanOrEqual(0.5);
    expect(c.overlap).toBe(1);
  });
  it('formats author lists in both conventions without losing anyone', () => {
    const list = authors('van der Berg, Ana and {The LLVM Project} and Smith, J.');
    expect(formatAuthorList(list, 'last-first', false).split(' and ')).toHaveLength(3);
    expect(formatAuthorList(list, 'first-last', false)).toContain('Ana van der Berg');
  });
});

describe('venue matching', () => {
  it('matches full names against their acronyms', () => {
    expect(venueSimilarity('ACM Conference on Computer and Communications Security', 'CCS')).toBeGreaterThan(0.85);
    expect(venueSimilarity('Proceedings of the 2024 CHI Conference on Human Factors in Computing Systems', 'CHI')).toBeGreaterThan(0.85);
  });
  it('matches an acronym against the initialism of the full venue name', () => {
    expect(venueSimilarity('ACM Conference on Computer and Communications Security', 'CCS')).toBeGreaterThan(0.85);
    expect(venueSimilarity('International Conference on Machine Learning', 'ICML')).toBeGreaterThan(0.85);
    expect(venueSimilarity('Conference on Neural Information Processing Systems', 'NeurIPS')).toBeLessThan(0.85); // not an initialism; no false match
  });
  it('does not merge unrelated venues that share an acronym-like token', () => {
    expect(venueSimilarity('ACM Conference on Computer and Communications Security', 'ICML')).toBeLessThan(0.7);
    expect(
      venueSimilarity('International Conference on Software Engineering', 'International Conference on Systems Engineering'),
    ).toBeLessThan(0.9);
    expect(venueSimilarity('International Conference on Machine Learning', 'International Conference on Managed Care')).toBeLessThan(0.7);
    expect(venueSimilarity('IEEE Transactions on Robotics', 'IEEE Transactions on Computers')).toBeLessThan(0.85);
  });
  it('treats arXiv and CoRR as the same preprint venue', () => {
    expect(venueSimilarity('arXiv preprint arXiv:2401.00001', 'CoRR')).toBeGreaterThan(0.8);
    expect(isPreprintVenue('arXiv preprint')).toBe(true);
    expect(isPreprintVenue('ACM Conference on Example Security')).toBe(false);
  });
  it('produces a short abbreviation for citation keys', () => {
    expect(venueAbbrev('Proceedings of the ACM Conference on Computer and Communications Security (CCS)')).toMatch(/ccs|acm/i);
  });
});

describe('pages', () => {
  it.each([
    ['120-131', '120--131'],
    ['120 - 131', '120--131'],
    ['120–131', '120--131'],
    ['120--131', '120--131'],
    ['e12345', 'e12345'],
  ])('normalises %j to %j', (a, b) => expect(normalizePages(a)).toBe(b));
  it('recognises abbreviated ranges as equivalent', () => {
    expect(pagesEquivalent('1234-56', '1234--1256')).toBe(true);
    expect(pagesEquivalent('1--10', '11--20')).toBe(false);
  });
  it('tokenisation is stable', () => {
    expect(tokenSimilarity(tokens('ACM Press'), tokens('acm press'))).toBe(1);
  });
});
