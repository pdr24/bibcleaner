import type { LookupResult } from '../models/types';

type FetchFn = typeof fetch;
let fetchImpl: FetchFn = (...args) => globalThis.fetch(...args);

/** Allows tests and the corpus harness to inject a fetch implementation. */
export function setFetch(fn: FetchFn): void {
  fetchImpl = fn;
}

interface HostState {
  queue: Promise<unknown>;
  last: number;
}
const hosts = new Map<string, HostState>();

/** Minimum spacing between requests per host (ms). One request in flight per host. */
const HOST_SPACING: Record<string, number> = {
  'api.crossref.org': 250,
  'api.datacite.org': 200,
  'dblp.org': 500,
  'api.openalex.org': 150,
  'export.arxiv.org': 3000,
  'doi.org': 150,
};

export const DEFAULT_TIMEOUT_MS = 8000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Serialises requests per host so we never exceed a provider's concurrency limit. */
function throttle<T>(host: string, task: () => Promise<T>): Promise<T> {
  const st = hosts.get(host) ?? { queue: Promise.resolve(), last: 0 };
  hosts.set(host, st);
  const run = st.queue.then(async () => {
    const wait = (HOST_SPACING[host] ?? 100) - (Date.now() - st.last);
    if (wait > 0) await sleep(wait);
    try {
      return await task();
    } finally {
      st.last = Date.now();
    }
  });
  st.queue = run.catch(() => undefined);
  return run;
}

export interface RequestOptions {
  accept?: string;
  timeoutMs?: number;
  /** Treat this HTTP status as "no record" (default 404). */
  notFound?: number[];
  /** Return the body for these error statuses instead of failing (e.g. doi.org 404 JSON). */
  passThrough?: number[];
  headers?: Record<string, string>;
}

export interface RawResponse {
  status: number;
  finalUrl: string;
  redirected: boolean;
  body: string;
  contentType: string;
}

const MAX_BODY_CHARS = 3_000_000;

async function once(url: string, opts: RequestOptions): Promise<LookupResult<RawResponse> & { retryAfter?: number }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: opts.accept ?? 'application/json', ...(opts.headers ?? {}) },
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: ctl.signal,
    });
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      return {
        status: 'RATE LIMITED',
        detail: 'The service asked us to slow down (HTTP 429).',
        retryAfter: Number.isFinite(ra) ? ra : undefined,
      };
    }
    const pass = (opts.passThrough ?? []).includes(res.status);
    if (!pass && (opts.notFound ?? [404]).includes(res.status)) return { status: 'NO RECORD FOUND', detail: `HTTP ${res.status}` };
    if (!pass && res.status >= 400) return { status: 'LOOKUP FAILED', detail: `HTTP ${res.status}` };
    let body = await res.text();
    if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS);
    return {
      status: 'OK',
      value: {
        status: res.status,
        finalUrl: res.url || url,
        redirected: res.redirected,
        body,
        contentType: res.headers.get('content-type') ?? '',
      },
    };
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return { status: 'LOOKUP FAILED', detail: 'Timed out' };
    const offline = typeof navigator !== 'undefined' && 'onLine' in navigator && navigator.onLine === false;
    return {
      status: offline ? 'NETWORK UNAVAILABLE' : 'LOOKUP FAILED',
      detail: offline ? 'You appear to be offline.' : `Request failed: ${(e as Error)?.message ?? 'network error'}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function request(url: string, opts: RequestOptions = {}): Promise<LookupResult<RawResponse>> {
  const host = new URL(url).host;
  return throttle(host, async () => {
    let r = await once(url, opts);
    if (r.status === 'RATE LIMITED') {
      // One polite retry, honouring Retry-After up to 5 s.
      await sleep(Math.min(5000, Math.max(1000, (r.retryAfter ?? 2) * 1000)));
      r = await once(url, opts);
    }
    const { retryAfter: _ignored, ...rest } = r;
    return rest;
  });
}

export async function getJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<LookupResult<T>> {
  const r = await request(url, opts);
  if (r.status !== 'OK' || !r.value) return { status: r.status, detail: r.detail };
  try {
    return { status: 'OK', value: JSON.parse(r.value.body) as T };
  } catch {
    // Say what arrived instead, so an interstitial, maintenance page or proxy
    // block can be told apart from a genuine API problem.
    const head = r.value.body.replace(/\s+/g, ' ').trim().slice(0, 60);
    const kind = /^<(!doctype|html)/i.test(head) ? 'an HTML page' : head ? `"${head}"` : 'an empty body';
    return { status: 'LOOKUP FAILED', detail: `Expected JSON but received ${kind} (HTTP ${r.value.status})` };
  }
}
