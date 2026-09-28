import type { LookupResult, Work, WorkType } from '../../core/models/types';
import { getJson } from '../../core/net/http';
import { cached, sha256 } from '../../core/net/cache';
import { stripMarkup } from '../../core/normalize/latex';
import { parseDoi } from '../../core/normalize/doi';
import type { ScholarlySource, WorkQuery } from '../types';
import { asArray, firstFamily, sourceSettings, titleQuery, yearFrom } from '../types';

const BASE = 'https://api.crossref.org';

const TYPE_MAP: Record<string, WorkType> = {
  'journal-article': 'article',
  'proceedings-article': 'inproceedings',
  'book-chapter': 'incollection',
  'book-part': 'incollection',
  'book-section': 'incollection',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  'reference-book': 'book',
  proceedings: 'proceedings',
  'posted-content': 'preprint',
  dissertation: 'phdthesis',
  report: 'techreport',
  dataset: 'dataset',
  standard: 'misc',
  other: 'misc',
};

function first(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mapCrossref(m: any): Work {
  const title = first(m.title);
  const subtitle = first(m.subtitle);
  const t = title ? stripMarkup(subtitle && !title.includes(subtitle) ? `${title}: ${subtitle}` : title).text : undefined;
  const dp = m.issued?.['date-parts']?.[0] ?? m['published-print']?.['date-parts']?.[0] ?? m['published-online']?.['date-parts']?.[0];
  const doi = parseDoi(m.DOI)?.doi;
  const rel = m.relation ?? {};
  const relatedDois: string[] = [];
  for (const k of ['is-preprint-of', 'has-preprint', 'is-version-of', 'has-version']) {
    for (const r of rel[k] ?? []) if (r['id-type'] === 'doi' && parseDoi(r.id)) relatedDois.push(parseDoi(r.id)!.doi);
  }
  const type = TYPE_MAP[m.type] ?? 'misc';
  return {
    title: t,
    authors: asArray<any>(m.author).map((a: any) =>
      a.family
        ? { family: String(a.family), given: String(a.given ?? '') }
        : { family: String(a.name ?? ''), given: '', literal: String(a.name ?? '') },
    ),
    year: yearFrom(dp?.[0]),
    venue: first(m['container-title']) ? stripMarkup(first(m['container-title'])!).text : m.event?.name,
    venueShort: first(m['short-container-title']),
    publisher: m.publisher,
    volume: m.volume,
    issue: m.issue,
    pages: m.page,
    doi,
    url: m.resource?.primary?.URL ?? m.URL,
    isbn: m.ISBN,
    issn: m.ISSN,
    type,
    isPreprint: m.type === 'posted-content' || m.subtype === 'preprint',
    relatedDois,
    sourceRecords: [
      {
        source: 'Crossref',
        recordUrl: doi ? `${BASE}/works/${encodeURIComponent(doi)}` : undefined,
        nativeId: doi,
        retrievedAt: Date.now(),
      },
    ],
  };
}

function withPolite(url: string): string {
  const e = sourceSettings.contactEmail?.trim();
  return e ? `${url}${url.includes('?') ? '&' : '?'}mailto=${encodeURIComponent(e)}` : url;
}

export class CrossrefAdapter implements ScholarlySource {
  readonly name = 'Crossref' as const;
  readonly supportsDoiLookup = true;
  getSourceName() {
    return this.name;
  }
  async lookupByDOI(doi: string): Promise<LookupResult<Work>> {
    const r = await cached(`crossref:doi:${doi.toLowerCase()}`, () => getJson<any>(withPolite(`${BASE}/works/${encodeURIComponent(doi)}`)));
    if (r.status !== 'OK') return { status: r.status, detail: r.detail };
    if (!r.value?.message || typeof r.value.message !== 'object') return { status: 'LOOKUP FAILED', detail: 'Unexpected response shape' };
    return { status: 'OK', value: mapCrossref(r.value.message) };
  }
  async searchWork(q: WorkQuery): Promise<LookupResult<Work[]>> {
    const title = titleQuery(q.title, 25);
    if (!title) return { status: 'NO RECORD FOUND', detail: 'No title to search for' };
    const params = new URLSearchParams({ 'query.bibliographic': [title, q.year ?? ''].join(' ').trim(), rows: '6' });
    const fam = firstFamily(q.authors);
    if (fam) params.set('query.author', fam);
    // Only fields on Crossref's documented select whitelist may appear here:
    // one unknown name (it used to include "subtype") makes the whole request
    // fail with HTTP 400.
    params.set(
      'select',
      'DOI,title,subtitle,author,issued,published-print,published-online,container-title,short-container-title,publisher,volume,issue,page,type,ISBN,ISSN,URL,relation,event',
    );
    const url = withPolite(`${BASE}/works?${params}`);
    let r = await cached(`crossref:search:${await sha256(params.toString())}`, () => getJson<any>(url));
    if (r.status === 'LOOKUP FAILED' && r.detail === 'HTTP 400') {
      // The whitelist changes occasionally. Rather than losing the search,
      // ask for whole records once; they are larger but always accepted.
      const full = new URLSearchParams(params);
      full.delete('select');
      r = await cached(`crossref:search:full:${await sha256(full.toString())}`, () => getJson<any>(withPolite(`${BASE}/works?${full}`)));
    }
    if (r.status !== 'OK') return { status: r.status, detail: r.detail };
    const items = asArray<any>(r.value?.message?.items);
    return items.length ? { status: 'OK', value: items.map(mapCrossref) } : { status: 'NO RECORD FOUND' };
  }
}
