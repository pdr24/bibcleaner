/**
 * QA pass: URL verification. HTTP 200 alone must never mean "verified", and an
 * ambiguous failure must never be reported as a dead link.
 */
import { checkUrl, extractPageMetadata, classifyUrl } from '../../core/verification/url';
import { setFetch } from '../../core/net/http';

type Fake = { status?: number; url?: string; redirected?: boolean; body?: string; type?: string; headers?: Record<string, string> };

const reply = (f: Fake, requested: string) =>
  ({
    status: f.status ?? 200,
    url: f.url ?? requested,
    redirected: f.redirected ?? false,
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-type' ? (f.type ?? 'text/html') : ((f.headers ?? {})[h.toLowerCase()] ?? null)),
    },
    text: async () => f.body ?? '<html><head><title>Page</title></head></html>',
  }) as unknown as Response;

const serve = (f: Fake | ((url: string) => Fake)) =>
  setFetch(async (input: any) => {
    const url = String(input);
    return reply(typeof f === 'function' ? f(url) : f, url);
  });

const PAPER =
  '<html><head><meta name="citation_title" content="Using AI for IoT Security in Smart Homes"><meta name="citation_doi" content="10.5555/1000001"></head></html>';
const cited = { title: 'Using AI for IoT Security in Smart Homes', doi: '10.5555/1000001' };

afterAll(() => setFetch((...a) => globalThis.fetch(...a)));

describe('URL verification states', () => {
  it('verifies only when the page identifies the same work', async () => {
    serve({ body: PAPER });
    const r = await checkUrl('https://dl.example.org/doi/10.5555/1000001', cited);
    expect(r.state).toBe('VERIFIED');
    expect(r.evidence.length).toBeGreaterThan(0);
  });
  it('does not verify a reachable page with no identifying metadata (HTTP 200 is not proof)', async () => {
    serve({ body: '<html><head><title>Publisher home</title></head></html>' });
    const r = await checkUrl('https://publisher.example.org/', cited);
    expect(r.state).toBe('UNVERIFIED');
  });
  it('flags a page that declares a different DOI', async () => {
    serve({
      body: '<html><head><meta name="citation_doi" content="10.5555/9999999"><meta name="citation_title" content="Protein Folding"></head></html>',
    });
    const r = await checkUrl('https://dl.example.org/doi/10.5555/9999999', cited);
    expect(r.state).toBe('CONFLICT');
  });
  it('flags a page whose title is a clearly different work', async () => {
    serve({ body: '<html><head><meta name="citation_title" content="Lattice Models of Protein Folding in Solution"></head></html>' });
    const r = await checkUrl('https://x.example.org/p', { title: cited.title });
    expect(r.state).toBe('CONFLICT');
  });
  it('accepts a matching page title as high confidence, not verified', async () => {
    serve({ body: '<html><head><meta name="citation_title" content="Using AI for IoT Security in Smart Homes"></head></html>' });
    const r = await checkUrl('https://x.example.org/p', { title: cited.title });
    expect(r.state).toBe('HIGH CONFIDENCE');
  });
  it.each([404, 410])('reports %d as unreachable', async (status) => {
    serve({ status });
    expect((await checkUrl('https://x.example.org/gone', cited)).state).toBe('UNREACHABLE');
  });
  it.each([401, 403])('reports %d as blocked, not as a wrong link', async (status) => {
    serve({ status });
    const r = await checkUrl('https://x.example.org/p', cited);
    expect(r.state).toBe('UNVERIFIED');
    expect(r.label).toMatch(/blocks automated checks/i);
  });
  it('reports 500 as an unreachable server error', async () => {
    serve({ status: 500 });
    expect((await checkUrl('https://x.example.org/p', cited)).state).toBe('UNREACHABLE');
  });
  it('reports a network failure as NOT CHECKED, never as a dead link', async () => {
    setFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const r = await checkUrl('https://x.example.org/p', cited);
    expect(r.state).toBe('NOT CHECKED');
    expect(r.detail).toMatch(/redirect|down|slow/i);
  });
  it('reports a timeout as NOT CHECKED', async () => {
    setFetch(
      (_i: any, init: any) =>
        new Promise((_res, rej) => {
          init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }) as Promise<Response>,
    );
    const r = await checkUrl('https://slow.example.org/p', cited);
    expect(r.state).toBe('NOT CHECKED');
  }, 20000);
  it('reports a non-HTML response as reachable but unverified', async () => {
    serve({ type: 'application/pdf', body: '%PDF-1.4' });
    expect((await checkUrl('https://x.example.org/p.pdf', cited)).state).toBe('UNVERIFIED');
  });
});

describe('URL verification and redirects', () => {
  it('follows a redirect and verifies against the final page', async () => {
    serve({ url: 'https://dl.example.org/doi/10.5555/1000001', redirected: true, body: PAPER });
    const r = await checkUrl('http://old.example.org/p', cited);
    expect(r.state).toBe('VERIFIED');
    expect(r.finalUrl).toBe('https://dl.example.org/doi/10.5555/1000001');
    expect(r.detail).toMatch(/redirect/i);
  });
  it('re-validates the final URL and refuses a redirect into a private address', async () => {
    serve({ url: 'http://169.254.169.254/latest/meta-data/', redirected: true, body: PAPER });
    const r = await checkUrl('https://public.example.org/p', cited);
    expect(r.state).toBe('CONFLICT');
    expect(r.detail).toMatch(/not fetched|Private/i);
  });
  it('refuses to fetch an unsafe URL before any request is made', async () => {
    let called = 0;
    setFetch(async () => {
      called++;
      return reply({}, 'x');
    });
    const r = await checkUrl('http://127.0.0.1:8080/admin', cited);
    expect(called).toBe(0);
    expect(r.state).toBe('NOT CHECKED');
  });
});

describe('page metadata extraction is inert', () => {
  it('reads Highwire, Dublin Core and OpenGraph without executing anything', () => {
    expect(extractPageMetadata('<meta name="DC.Title" content="A Title">').title).toBe('A Title');
    expect(extractPageMetadata('<meta property="og:title" content="OG Title">').title).toBe('OG Title');
    // Entities are decoded to plain text for comparison; the value is never
    // interpreted as markup (the UI renders it through React's text escaping,
    // covered by the XSS case in tests/e2e/ui_e2e.py).
    const m = extractPageMetadata('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(m.title).toBe('<script>alert(1)</script>');
    expect(extractPageMetadata('<meta name="citation_title" content="A &amp; B">').title).toBe('A & B');
  });
  it('classifies DOI, arXiv and plain web URLs', () => {
    expect(classifyUrl('https://doi.org/10.5555/x')).toEqual({ kind: 'doi', doi: '10.5555/x' });
    expect(classifyUrl('https://arxiv.org/abs/2401.00001v2').kind).toBe('arxiv');
    expect(classifyUrl('https://example.org/p')).toEqual({ kind: 'web' });
  });
});
