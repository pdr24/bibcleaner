import type { LookupResult, Work, WorkType } from '../../core/models/types';
import { getJson } from '../../core/net/http';
import { cached, sha256 } from '../../core/net/cache';
import { parseDoi } from '../../core/normalize/doi';
import type { ScholarlySource, WorkQuery } from '../types';
import { splitDisplayName, titleQuery, yearFrom } from '../types';

const BASE = 'https://dblp.org';

const TYPE_MAP: Record<string, WorkType> = {
  'Conference and Workshop Papers': 'inproceedings',
  'Journal Articles': 'article',
  'Books and Theses': 'book',
  'Parts in Books or Collections': 'incollection',
  Editorship: 'proceedings',
  'Informal and Other Publications': 'misc',
  'Informal Publications': 'misc',
  'Reference Works': 'misc',
  'Data and Artifacts': 'dataset',
};

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapDblp(info: any): Work {
  const venue = arr<string>(info.venue)[0];
  const isCorr = venue === 'CoRR';
  const ees = arr<string>(info.ee);
  const arxivEe = ees.find((e) => /arxiv\.org\/abs\//i.test(e));
  const arxivId =
    arxivEe?.split(/abs\//i)[1] ?? (isCorr && typeof info.volume === 'string' ? info.volume.replace(/^abs\//, '') : undefined);
  const title = typeof info.title === 'string' ? info.title.replace(/\.$/, '') : undefined;
  const key: string | undefined = info.key;
  return {
    title,
    authors: arr<any>(info.authors?.author).map((a) => splitDisplayName(typeof a === 'string' ? a : (a.text ?? ''))),
    year: yearFrom(info.year),
    venue,
    venueShort: venue,
    volume: isCorr ? undefined : info.volume,
    issue: info.number,
    pages: info.pages,
    doi: parseDoi(info.doi)?.doi,
    url: ees[0],
    arxivId,
    type: isCorr ? 'preprint' : (TYPE_MAP[info.type] ?? 'misc'),
    isPreprint: isCorr,
    sourceRecords: [
      { source: 'DBLP', recordUrl: info.url ?? (key ? `${BASE}/rec/${key}` : undefined), nativeId: key, retrievedAt: Date.now() },
    ],
  };
}

/**
 * DBLP's search box is a query language, not free text: a stray "-" or a
 * one-character token makes it answer with an HTML error page (HTTP 200)
 * rather than JSON. Only plain alphanumeric words of two characters or more
 * are sent; DBLP matches prefixes, so nothing useful is lost.
 */
export function dblpQuery(title: string | undefined): string {
  return titleQuery(title, 20)
    .replace(/-+/g, ' ')
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}]{2,}$/u.test(w))
    .slice(0, 10)
    .join(' ');
}

export class DBLPAdapter implements ScholarlySource {
  readonly name = 'DBLP' as const;
  /** DBLP's public search API does not offer reliable lookup by DOI. */
  readonly supportsDoiLookup = false;
  getSourceName() {
    return this.name;
  }
  async lookupByDOI(): Promise<LookupResult<Work>> {
    return { status: 'NO RECORD FOUND', detail: 'DBLP does not support DOI lookup' };
  }
  async searchWork(q: WorkQuery): Promise<LookupResult<Work[]>> {
    const t = dblpQuery(q.title);
    if (!t) return { status: 'NO RECORD FOUND', detail: 'No searchable words in the title' };
    const params = new URLSearchParams({ q: t, format: 'json', h: '8' });
    // DBLP answers overload and rate limiting with an HTML page rather than a
    // status code, and it usually passes within a second. One retry, then the
    // failure is reported as a failure (never as "no record").
    const fetchOnce = () => getJson<any>(`${BASE}/search/publ/api?${params}`);
    const r = await cached(`dblp:search:${await sha256(params.toString())}`, async () => {
      const first = await fetchOnce();
      if (first.status === 'LOOKUP FAILED' && first.detail?.startsWith('Expected JSON')) {
        await new Promise((res) => setTimeout(res, 800));
        return fetchOnce();
      }
      return first;
    });
    if (r.status !== 'OK') return { status: r.status, detail: r.detail };
    const hits = arr<any>(r.value?.result?.hits?.hit);
    return hits.length ? { status: 'OK', value: hits.map((h) => mapDblp(h.info)) } : { status: 'NO RECORD FOUND' };
  }
}
