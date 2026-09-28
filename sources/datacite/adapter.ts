import type { LookupResult, Work, WorkType } from '../../core/models/types';
import { getJson } from '../../core/net/http';
import { cached, sha256 } from '../../core/net/cache';
import { isArxivDoi, parseDoi } from '../../core/normalize/doi';
import type { ScholarlySource, WorkQuery } from '../types';
import { asArray, titleQuery, yearFrom } from '../types';

const BASE = 'https://api.datacite.org';

const TYPE_MAP: Record<string, WorkType> = {
  JournalArticle: 'article',
  ConferencePaper: 'inproceedings',
  Book: 'book',
  BookChapter: 'incollection',
  Dissertation: 'phdthesis',
  Report: 'techreport',
  Dataset: 'dataset',
  Software: 'software',
  Preprint: 'preprint',
  Text: 'misc',
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapDataCite(d: any): Work {
  const a = d.attributes ?? {};
  const doi = parseDoi(a.doi)?.doi;
  const arxiv = isArxivDoi(doi) ? doi!.replace(/^10\.48550\/arxiv\./i, '') : undefined;
  const rtg = a.types?.resourceTypeGeneral as string | undefined;
  const relatedDois: string[] = [];
  for (const r of a.relatedIdentifiers ?? []) {
    if (r.relatedIdentifierType === 'DOI' && /version|preprint/i.test(r.relationType ?? '') && parseDoi(r.relatedIdentifier))
      relatedDois.push(parseDoi(r.relatedIdentifier)!.doi);
  }
  return {
    title: a.titles?.[0]?.title,
    authors: asArray<any>(a.creators).map((c: any) =>
      c.familyName
        ? { family: c.familyName, given: c.givenName ?? '' }
        : c.nameType === 'Organizational'
          ? { family: c.name, given: '', literal: c.name }
          : splitComma(c.name ?? ''),
    ),
    year: yearFrom(a.publicationYear),
    venue: arxiv ? 'arXiv' : a.container?.title,
    publisher: typeof a.publisher === 'string' ? a.publisher : a.publisher?.name,
    volume: a.container?.volume,
    issue: a.container?.issue,
    pages: a.container?.firstPage && a.container?.lastPage ? `${a.container.firstPage}--${a.container.lastPage}` : undefined,
    doi,
    url: a.url,
    arxivId: arxiv,
    type: arxiv ? 'preprint' : (TYPE_MAP[rtg ?? ''] ?? 'misc'),
    isPreprint: !!arxiv || rtg === 'Preprint',
    relatedDois,
    sourceRecords: [
      {
        source: 'DataCite',
        recordUrl: doi ? `https://commons.datacite.org/doi.org/${doi}` : undefined,
        nativeId: doi,
        retrievedAt: Date.now(),
      },
    ],
  };
}

function splitComma(name: string) {
  const [family, given] = name.split(',').map((x: string) => x.trim());
  return { family: family ?? name, given: given ?? '' };
}

export class DataCiteAdapter implements ScholarlySource {
  readonly name = 'DataCite' as const;
  readonly supportsDoiLookup = true;
  getSourceName() {
    return this.name;
  }
  async lookupByDOI(doi: string): Promise<LookupResult<Work>> {
    const r = await cached(`datacite:doi:${doi.toLowerCase()}`, () =>
      getJson<any>(`${BASE}/dois/${encodeURIComponent(doi)}`, { accept: 'application/vnd.api+json' }),
    );
    if (r.status !== 'OK') return { status: r.status, detail: r.detail };
    if (!r.value?.data || typeof r.value.data !== 'object' || Array.isArray(r.value.data))
      return { status: 'LOOKUP FAILED', detail: 'Unexpected response shape' };
    return { status: 'OK', value: mapDataCite(r.value.data) };
  }
  async searchWork(q: WorkQuery): Promise<LookupResult<Work[]>> {
    const t = titleQuery(q.title)
      .replace(/[+\-!(){}[\]^"~*?:\\/]/g, ' ')
      .trim();
    if (!t) return { status: 'NO RECORD FOUND' };
    const params = new URLSearchParams({ query: `titles.title:(${t})`, 'page[size]': '5' });
    const r = await cached(`datacite:search:${await sha256(params.toString())}`, () =>
      getJson<any>(`${BASE}/dois?${params}`, { accept: 'application/vnd.api+json' }),
    );
    if (r.status !== 'OK') return { status: r.status, detail: r.detail };
    const items = asArray<any>(r.value?.data);
    return items.length ? { status: 'OK', value: items.map(mapDataCite) } : { status: 'NO RECORD FOUND' };
  }
}
