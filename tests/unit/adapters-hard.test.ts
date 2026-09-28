/**
 * QA pass: every adapter, against malformed, partial and failing responses.
 * The contract: never throw, never invent, and always distinguish "no record"
 * from "could not be checked".
 */
import { CrossrefAdapter, mapCrossref } from '../../sources/crossref/adapter';
import { DataCiteAdapter, mapDataCite } from '../../sources/datacite/adapter';
import { DBLPAdapter, dblpQuery, mapDblp } from '../../sources/dblp/adapter';
import { OpenAlexAdapter, mapOpenAlex } from '../../sources/openalex/adapter';
import { ArxivAdapter, mapArxivAtom, parseArxivId } from '../../sources/arxiv/adapter';
import { resolveDoi } from '../../sources/doiResolver';
import { setFetch } from '../../core/net/http';
import { setKV } from '../../core/net/cache';
import { sourceSettings } from '../../sources/types';

const noCache = () => setKV({ get: async () => undefined, set: async () => {}, clear: async () => {} });
const json = (body: unknown, status = 200) =>
  ({
    status,
    url: 'https://x/',
    redirected: false,
    headers: { get: () => 'application/json' },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as unknown as Response;

const requests: string[] = [];
const serve = (fn: (url: string) => Response | Promise<Response>) =>
  setFetch(async (input: any) => {
    requests.push(String(input));
    return fn(String(input));
  });

beforeEach(() => {
  requests.length = 0;
  noCache();
  sourceSettings.contactEmail = undefined;
});
afterAll(() => setFetch((...a) => globalThis.fetch(...a)));

const DBLP_HIT = {
  result: {
    hits: {
      hit: [
        {
          info: {
            title: 'Using AI for IoT Security in Smart Homes.',
            authors: { author: [{ text: 'John Smith' }] },
            venue: 'EXSEC',
            year: '2024',
          },
        },
      ],
    },
  },
};

const query = {
  title: 'Using AI for IoT Security in Smart Homes',
  authors: [{ family: 'Smith', given: 'John' }],
  year: 2024,
  venue: 'EXSEC',
};

const adapters = () => [new CrossrefAdapter(), new DataCiteAdapter(), new DBLPAdapter(), new OpenAlexAdapter()];

describe('adapter failure handling', () => {
  it.each([
    [400, 'LOOKUP FAILED'],
    [403, 'LOOKUP FAILED'],
    [404, 'NO RECORD FOUND'],
    [429, 'RATE LIMITED'],
    [500, 'LOOKUP FAILED'],
    [503, 'LOOKUP FAILED'],
  ])(
    'HTTP %d on search maps to %s',
    async (status, expected) => {
      serve(() => json({}, status));
      for (const a of adapters()) {
        const r = await a.searchWork(query);
        expect([expected, 'NO RECORD FOUND'], `${a.name} on ${status}`).toContain(r.status);
        if (status !== 404) expect(r.status, `${a.name} must not claim "no record" on HTTP ${status}`).toBe(expected);
      }
    },
    30000,
  );

  it('network failure never looks like an empty result', async () => {
    setFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    for (const a of adapters()) {
      expect((await a.searchWork(query)).status, a.name).toBe('LOOKUP FAILED');
      expect((await a.lookupByDOI('10.5555/1')).status, a.name).not.toBe('OK');
    }
  }, 30000);

  it('malformed JSON is a failure, not a record, and says what arrived', async () => {
    serve(() => json('{ not json'));
    for (const a of adapters()) expect((await a.searchWork(query)).status, a.name).toBe('LOOKUP FAILED');
    serve(() => json('<!DOCTYPE html><html><body>Service temporarily unavailable</body></html>'));
    const r = await new DBLPAdapter().searchWork(query);
    expect(r.detail).toMatch(/Expected JSON but received an HTML page \(HTTP 200\)/);
  }, 20000);

  it('DBLP retries once when it serves an HTML page instead of JSON', async () => {
    let n = 0;
    serve(() => {
      n++;
      return n === 1 ? json('<!DOCTYPE html><html>Too many requests</html>') : json(DBLP_HIT);
    });
    const r = await new DBLPAdapter().searchWork(query);
    expect(n).toBe(2);
    expect(r.status).toBe('OK');
  }, 20000);

  it('does not retry forever: a persistent HTML page is a failure, not "no record"', async () => {
    let n = 0;
    serve(() => {
      n++;
      return json('<!DOCTYPE html><html>Service unavailable</html>');
    });
    const r = await new DBLPAdapter().searchWork(query);
    expect(n).toBe(2);
    expect(r.status).toBe('LOOKUP FAILED');
  }, 20000);

  it.each([{}, { message: null }, { message: { items: null } }, { result: {} }, { results: 'oops' }, { data: [{}] }])(
    'unexpected response shape %j never throws',
    async (body) => {
      serve(() => json(body));
      for (const a of adapters()) {
        const r = await a.searchWork(query);
        expect(['OK', 'NO RECORD FOUND', 'LOOKUP FAILED']).toContain(r.status);
        if (r.status === 'OK') for (const w of r.value!) expect(Array.isArray(w.authors)).toBe(true);
      }
    },
    30000,
  );

  it('an empty result set is NO RECORD FOUND', async () => {
    serve((u) =>
      u.includes('crossref')
        ? json({ message: { items: [] } })
        : u.includes('dblp')
          ? json({ result: { hits: {} } })
          : u.includes('openalex')
            ? json({ results: [] })
            : json({ data: [] }),
    );
    for (const a of adapters()) expect((await a.searchWork(query)).status, a.name).toBe('NO RECORD FOUND');
  }, 20000);

  it('rate limiting retries once and then reports RATE LIMITED', async () => {
    let n = 0;
    setFetch(async () => {
      n++;
      return {
        status: 429,
        url: 'https://x/',
        redirected: false,
        headers: { get: (h: string) => (h === 'retry-after' ? '0' : null) },
        text: async () => '',
      } as unknown as Response;
    });
    const r = await new CrossrefAdapter().lookupByDOI('10.5555/1');
    expect(r.status).toBe('RATE LIMITED');
    expect(n).toBe(2);
  });
});

describe('DBLP query sanitising', () => {
  it.each([
    ['Learning - Based Control of Robots', 'Learning Based Control of Robots'],
    [
      'Block-Based Programming in K-12 Classrooms',
      'Block Based Programming in K 12 Classrooms'.replace(/\bK\b /, '').replace(' 12 ', ' 12 '),
    ],
    ['A Survey: $O(n)$ Bounds & More', 'Survey Bounds More'],
    ['Na\\"{\\i}ve Bayes — A Review', 'Naive Bayes Review'],
  ])('%j becomes a plain word query', (title) => {
    const q = dblpQuery(title);
    expect(q).toMatch(/^[\p{L}\p{N}]+( [\p{L}\p{N}]+)*$/u);
    expect(q).not.toMatch(/(^|\s)[-:&$]/);
    expect(q.split(' ').every((w) => w.length >= 2)).toBe(true);
  });
  it('sends no request at all when nothing searchable is left', async () => {
    requests.length = 0;
    const r = await new DBLPAdapter().searchWork({ title: '- : $ %', authors: [] });
    expect(r.status).toBe('NO RECORD FOUND');
    expect(requests).toEqual([]);
  });
  it('keeps the query short enough for DBLP', () => {
    expect(dblpQuery('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron').split(' ')).toHaveLength(10);
    // single-character noise is dropped rather than sent as a bare token
    expect(dblpQuery('a b c Deep Learning')).toBe('Deep Learning');
  });
});

describe('search queries decode LaTeX before sending', () => {
  it('accented titles are searched as words, not as fragments', async () => {
    serve(() => json({ message: { items: [] } }));
    await new CrossrefAdapter().searchWork({ title: 'Na\\"{\\i}ve Bayes for Caf{\\\'e} Reviews', authors: [] });
    const q = new URL(requests.at(-1)!).searchParams.get('query.bibliographic')!;
    expect(q).toContain('Naive');
    expect(q).toContain('Cafe');
    expect(q).not.toMatch(/\\|\{|\}/);
  });
});

describe('Crossref search field selection', () => {
  it('asks only for fields on the documented select whitelist', async () => {
    // Crossref rejects the whole request with HTTP 400 if one name is unknown.
    const WHITELIST = new Set(
      (
        'DOI ISBN ISSN URL abstract accepted alternative-id approved archive article-number assertion author chair clinical-trial-number container-title ' +
        'content-created content-domain created degree deposited editor event funder group-title indexed is-referenced-by-count issn-type issue issued license ' +
        'link member original-title page posted prefix published published-online published-print publisher publisher-location reference references-count relation ' +
        'score short-container-title short-title standards-body subject subtitle title translator type update-policy update-to updated-by volume'
      ).split(' '),
    );
    serve(() => json({ message: { items: [] } }));
    await new CrossrefAdapter().searchWork(query);
    const select = new URL(requests.at(-1)!).searchParams.get('select')!;
    for (const f of select.split(',')) expect(WHITELIST.has(f), `"${f}" is not a Crossref select field`).toBe(true);
  });

  it('falls back to whole records when Crossref rejects the field list', async () => {
    const seen: string[] = [];
    serve((u) => {
      seen.push(u);
      if (new URL(u).searchParams.has('select')) return json({}, 400);
      return json({ message: { items: [{ DOI: '10.5555/1', title: ['T'] }] } });
    });
    const r = await new CrossrefAdapter().searchWork(query);
    expect(r.status).toBe('OK');
    expect(r.value![0].doi).toBe('10.5555/1');
    expect(seen).toHaveLength(2);
  });
});

describe('adapter mapping of partial records', () => {
  it('Crossref: missing author/title/date fields produce empty, not invented, values', () => {
    const w = mapCrossref({ DOI: '10.5555/x' });
    expect(w).toMatchObject({ authors: [], title: undefined, year: undefined, doi: '10.5555/x' });
    const w2 = mapCrossref({ title: ['T'], author: [{ name: 'The Consortium' }, { family: 'Doe' }], issued: { 'date-parts': [[]] } });
    expect(w2.authors[0].literal).toBe('The Consortium');
    expect(w2.authors[1]).toEqual({ family: 'Doe', given: '' });
    expect(w2.year).toBeUndefined();
  });
  it('Crossref: strips JATS markup and joins subtitles once', () => {
    const w = mapCrossref({ title: ['Deep <i>Learning</i>'], subtitle: ['A Survey'] });
    expect(w.title).toBe('Deep Learning: A Survey');
    expect(mapCrossref({ title: ['T: A Survey'], subtitle: ['A Survey'] }).title).toBe('T: A Survey');
  });
  it('DataCite: organisational creators and container fields', () => {
    const w = mapDataCite({
      attributes: {
        doi: '10.5555/d',
        titles: [{ title: 'T' }],
        creators: [{ name: 'CERN', nameType: 'Organizational' }],
        publicationYear: '2021',
        types: { resourceTypeGeneral: 'Dataset' },
      },
    });
    expect(w.authors[0].literal).toBe('CERN');
    expect(w.type).toBe('dataset');
    expect(w.year).toBe(2021);
  });
  it('DBLP: array or single author, and missing venue', () => {
    expect(mapDblp({ title: 'T.', authors: { author: [{ text: 'A B' }, { text: 'C D' }] }, year: '2020' }).authors).toHaveLength(2);
    expect(mapDblp({ title: 'T.' }).authors).toEqual([]);
  });
  it('OpenAlex: nulls in biblio and locations', () => {
    const w = mapOpenAlex({
      display_name: 'T',
      biblio: { first_page: null, last_page: null },
      authorships: [{ author: { display_name: null } }],
      primary_location: null,
    });
    expect(w.pages).toBeUndefined();
    expect(w.venue).toBeUndefined();
    expect(w.authors).toHaveLength(1);
  });
  it('OpenAlex: same first and last page is not a range', () => {
    expect(mapOpenAlex({ display_name: 'T', biblio: { first_page: '7', last_page: '7' } }).pages).toBe('7');
  });
  it('arXiv: malformed Atom yields no record rather than a broken Work', () => {
    expect(mapArxivAtom('<feed></feed>')).toBeNull();
    expect(mapArxivAtom('not xml at all')).toBeNull();
    expect(mapArxivAtom('<feed><entry><id>http://arxiv.org/abs/2401.00001</id><title>Error</title></entry></feed>')).toBeNull();
    expect(mapArxivAtom('<feed><entry><id>http://arxiv.org/abs/2401.00001v1</id><title>T</title></entry></feed>')).toMatchObject({
      arxivId: '2401.00001',
    });
  });
  it.each(['arXiv:2401.00001', '2401.00001v3', 'https://arxiv.org/abs/2401.00001', 'cs/0112017', 'arxiv.org/pdf/2401.00001v2'])(
    'parses arXiv id from %s',
    (s) => {
      expect(parseArxivId(s)).toBeTruthy();
    },
  );
  it.each(['', 'not-an-id', 'https://example.org/abs/x', '99.9', 'arXiv:2401'])('rejects %j as an arXiv id', (s) =>
    expect(parseArxivId(s)).toBeNull(),
  );
});

describe('DOI resolver', () => {
  it('responseCode 100 means the DOI is unknown, not a failure', async () => {
    serve(() => json({ responseCode: 100 }, 404));
    const r = await resolveDoi('10.5555/nope');
    expect(r.status).toBe('NO RECORD FOUND');
    expect(r.value?.exists).toBe(false);
  });
  it('returns the registered target for a live DOI', async () => {
    serve(() => json({ responseCode: 1, values: [{ type: 'URL', data: { value: 'https://dl.example.org/p' } }] }));
    const r = await resolveDoi('10.5555/yes');
    expect(r).toMatchObject({ status: 'OK', value: { exists: true, target: 'https://dl.example.org/p' } });
  });
  it('an unexpected responseCode is a failure, not "does not exist"', async () => {
    serve(() => json({ responseCode: 2 }));
    expect((await resolveDoi('10.5555/weird')).status).toBe('LOOKUP FAILED');
  });
  it('a 500 from doi.org is not evidence about the DOI', async () => {
    serve(() => json({}, 500));
    expect((await resolveDoi('10.5555/x')).status).toBe('LOOKUP FAILED');
  });
});

describe('privacy of outbound requests', () => {
  it('sends only identifiers and query fields, and no contact e-mail unless configured', async () => {
    serve(() => json({ message: { items: [] } }));
    await new CrossrefAdapter().searchWork({ ...query, authors: [{ family: 'Smith', given: 'John' }] });
    const url = requests.at(-1)!;
    expect(url).not.toMatch(/mailto/);
    expect(url.startsWith('https://api.crossref.org/')).toBe(true);
    // The abstract, notes and other private fields are not part of the query interface at all.
    expect(url).not.toMatch(/abstract|note|keywords/i);
  });
  it('adds the contact e-mail only when the user set one', async () => {
    sourceSettings.contactEmail = 'me@uni.edu';
    serve(() => json({ message: { items: [] } }));
    await new CrossrefAdapter().searchWork(query);
    expect(requests.at(-1)).toMatch(/mailto=me%40uni.edu/);
    sourceSettings.contactEmail = undefined;
  });
});
