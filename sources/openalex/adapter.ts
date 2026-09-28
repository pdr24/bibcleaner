import type { LookupResult, Work, WorkType } from '../../core/models/types';
import { getJson } from '../../core/net/http';
import { cached, sha256 } from '../../core/net/cache';
import { parseDoi } from '../../core/normalize/doi';
import type { ScholarlySource, WorkQuery } from '../types';
import { asArray, sourceSettings, splitDisplayName, titleQuery, yearFrom } from '../types';

const BASE = 'https://api.openalex.org';

const TYPE_MAP: Record<string, WorkType> = {
  article: 'article',
  'book-chapter': 'incollection',
  book: 'book',
  dissertation: 'phdthesis',
  preprint: 'preprint',
  report: 'techreport',
  dataset: 'dataset',
  standard: 'misc',
  other: 'misc',
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapOpenAlex(w: any): Work {
  const src = w.primary_location?.source;
  const venue: string | undefined = src?.display_name;
  const isArxiv = /arxiv/i.test(venue ?? '');
  const b = w.biblio ?? {};
  const doi = parseDoi(w.doi)?.doi;
  const arxivLoc = (w.locations ?? []).find((l: any) => /arxiv\.org\/abs\//i.test(l.landing_page_url ?? ''));
  let type: WorkType = TYPE_MAP[w.type] ?? 'misc';
  if (w.type === 'article' && src?.type === 'conference') type = 'inproceedings';
  return {
    title: w.display_name ?? w.title,
    authors: asArray<any>(w.authorships).map((a: any) => splitDisplayName(a.author?.display_name ?? a.raw_author_name ?? '')),
    year: yearFrom(w.publication_year),
    venue,
    publisher: src?.host_organization_name,
    volume: b.volume ?? undefined,
    issue: b.issue ?? undefined,
    pages: b.first_page && b.last_page && b.first_page !== b.last_page ? `${b.first_page}--${b.last_page}` : (b.first_page ?? undefined),
    doi,
    url: w.primary_location?.landing_page_url,
    arxivId: arxivLoc ? arxivLoc.landing_page_url.split(/abs\//i)[1] : undefined,
    issn: src?.issn ?? undefined,
    type,
    isPreprint: w.type === 'preprint' || isArxiv,
    sourceRecords: [{ source: 'OpenAlex', recordUrl: w.id, nativeId: w.id, retrievedAt: Date.now() }],
  };
}

function withParams(url: string): string {
  const u = new URL(url);
  if (sourceSettings.contactEmail) u.searchParams.set('mailto', sourceSettings.contactEmail);
  if (sourceSettings.openAlexApiKey) u.searchParams.set('api_key', sourceSettings.openAlexApiKey);
  return u.toString();
}

export class OpenAlexAdapter implements ScholarlySource {
  readonly name = 'OpenAlex' as const;
  readonly supportsDoiLookup = true;
  getSourceName() {
    return this.name;
  }
  async lookupByDOI(doi: string): Promise<LookupResult<Work>> {
    const r = await cached(`openalex:doi:${doi.toLowerCase()}`, () =>
      getJson<any>(withParams(`${BASE}/works/doi:${encodeURIComponent(doi)}`)),
    );
    if (r.status !== 'OK') return { status: r.status, detail: r.detail };
    return { status: 'OK', value: mapOpenAlex(r.value) };
  }
  async searchWork(q: WorkQuery): Promise<LookupResult<Work[]>> {
    const t = titleQuery(q.title, 20);
    if (!t) return { status: 'NO RECORD FOUND' };
    const url = withParams(`${BASE}/works?${new URLSearchParams({ search: t, 'per-page': '6' })}`);
    const r = await cached(`openalex:search:${await sha256(t)}`, () => getJson<any>(url));
    if (r.status !== 'OK') return { status: r.status, detail: r.detail };
    const items = asArray<any>(r.value?.results);
    return items.length ? { status: 'OK', value: items.map(mapOpenAlex) } : { status: 'NO RECORD FOUND' };
  }
}
