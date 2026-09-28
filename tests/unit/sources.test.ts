import { mapCrossref } from '../../sources/crossref/adapter';
import { mapDblp } from '../../sources/dblp/adapter';
import { mapOpenAlex } from '../../sources/openalex/adapter';
import { mapDataCite } from '../../sources/datacite/adapter';
import { mapArxivAtom, parseArxivId } from '../../sources/arxiv/adapter';
import { extractPageMetadata, classifyUrl } from '../../core/verification/url';
import { setFetch, request } from '../../core/net/http';

// Response shapes follow each API's documented format; values are synthetic.
describe('source adapters map into the canonical Work', () => {
  it('Crossref', () => {
    const w = mapCrossref({
      DOI: '10.5555/ABC',
      title: ['Learning <i>Fast</i>'],
      subtitle: ['A Study'],
      author: [{ given: 'Jane', family: 'Doe' }, { name: 'The Consortium' }],
      issued: { 'date-parts': [[2024, 5]] },
      'container-title': ['Proc. Example'],
      type: 'proceedings-article',
      page: '1-10',
      publisher: 'ACM',
      relation: { 'has-preprint': [{ 'id-type': 'doi', id: '10.48550/arXiv.2401.00001' }] },
    });
    expect(w).toMatchObject({
      title: 'Learning Fast: A Study',
      year: 2024,
      venue: 'Proc. Example',
      type: 'inproceedings',
      pages: '1-10',
      doi: '10.5555/ABC',
      relatedDois: ['10.48550/arXiv.2401.00001'],
    });
    expect(w.authors[1].literal).toBe('The Consortium');
  });
  it('DBLP (single author object, CoRR, homonym suffix)', () => {
    const w = mapDblp({
      title: 'A Paper.',
      authors: { author: { text: 'Jane Doe 0002' } },
      venue: 'CoRR',
      volume: 'abs/2401.00001',
      year: '2024',
      type: 'Informal and Other Publications',
      key: 'journals/corr/abs-2401-00001',
      ee: 'https://arxiv.org/abs/2401.00001',
    });
    expect(w).toMatchObject({ title: 'A Paper', isPreprint: true, arxivId: '2401.00001', year: 2024 });
    expect(w.authors).toEqual([{ family: 'Doe', given: 'Jane' }]);
  });
  it('OpenAlex', () => {
    const w = mapOpenAlex({
      id: 'https://openalex.org/W1',
      display_name: 'T',
      publication_year: 2020,
      doi: 'https://doi.org/10.5555/x',
      type: 'article',
      authorships: [{ author: { display_name: 'Ana van der Berg' } }],
      primary_location: { source: { display_name: 'Conf X', type: 'conference' } },
      biblio: { first_page: '5', last_page: '9' },
    });
    expect(w).toMatchObject({ doi: '10.5555/x', type: 'inproceedings', pages: '5--9' });
    expect(w.authors[0]).toEqual({ family: 'van der Berg', given: 'Ana' });
  });
  it('DataCite arXiv DOI', () => {
    const w = mapDataCite({
      attributes: {
        doi: '10.48550/arxiv.2401.00001',
        titles: [{ title: 'T' }],
        creators: [{ familyName: 'Doe', givenName: 'Jane' }],
        publicationYear: 2024,
        types: { resourceTypeGeneral: 'Preprint' },
      },
    });
    expect(w).toMatchObject({ isPreprint: true, arxivId: '2401.00001', venue: 'arXiv' });
  });
  it('arXiv Atom', () => {
    const xml =
      '<feed><entry><id>http://arxiv.org/abs/2401.00001v2</id><published>2024-01-01T00:00:00Z</published><title>A  Title &amp; More</title><author><name>Jane Doe</name></author><arxiv:doi>10.5555/pub</arxiv:doi></entry></feed>';
    expect(mapArxivAtom(xml)).toMatchObject({ title: 'A Title & More', arxivId: '2401.00001', year: 2024, relatedDois: ['10.5555/pub'] });
    expect(parseArxivId('arXiv:cs/0112017v1')).toBe('cs/0112017v1');
  });
});

describe('URL metadata', () => {
  it('reads Highwire meta tags', () => {
    const m = extractPageMetadata(
      '<html><head><title>Site</title><meta name="citation_title" content="Real Title"><meta name="citation_doi" content="10.5555/x"></head>',
    );
    expect(m).toEqual({ title: 'Real Title', doi: '10.5555/x' });
  });
  it('classifies DOI and arXiv links', () => {
    expect(classifyUrl('https://doi.org/10.5555/x')).toEqual({ kind: 'doi', doi: '10.5555/x' });
    expect(classifyUrl('https://arxiv.org/pdf/2401.00001v3')).toEqual({ kind: 'arxiv', id: '2401.00001' });
  });
});

describe('HTTP layer distinguishes failure kinds', () => {
  const resp = (status: number, body = '{}', headers: Record<string, string> = {}) => new Response(body, { status, headers });
  it('404 -> NO RECORD FOUND, 500 -> LOOKUP FAILED, TypeError -> LOOKUP FAILED', async () => {
    setFetch(async () => resp(404));
    expect((await request('https://t1.example/x')).status).toBe('NO RECORD FOUND');
    setFetch(async () => resp(503));
    expect((await request('https://t2.example/x')).status).toBe('LOOKUP FAILED');
    setFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect((await request('https://t3.example/x')).status).toBe('LOOKUP FAILED');
  });
  it('retries once on 429 then reports RATE LIMITED', async () => {
    let n = 0;
    setFetch(async () => {
      n++;
      return resp(429, '', { 'retry-after': '0' });
    });
    expect((await request('https://t4.example/x')).status).toBe('RATE LIMITED');
    expect(n).toBe(2);
  });
});
