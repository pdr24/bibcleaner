import type { Author, LookupResult, SourceName, Work } from '../../core/models/types';
import type { Sources } from '../../core/verification/pipeline';
import type { ScholarlySource } from '../../sources/types';
import { sameDoi } from '../../core/normalize/doi';

/** Synthetic records use the Crossref test prefix 10.5555 — they are NOT real publications. */
export function work(source: SourceName, w: Omit<Partial<Work>, 'authors'> & { authors?: (string | Author)[] }): Work {
  const authors = (w.authors ?? []).map((a) => {
    if (typeof a !== 'string') return a;
    const parts = a.split(' ');
    return { family: parts.pop()!, given: parts.join(' ') };
  });
  return { ...w, authors, sourceRecords: [{ source, retrievedAt: 0, recordUrl: `https://example.org/${source}` }] } as Work;
}

export type Failure = 'LOOKUP FAILED' | 'RATE LIMITED' | 'NETWORK UNAVAILABLE';

export interface MockData {
  records?: Work[];
  /** Search results per source; if omitted, search returns every record of that source. */
  search?: Partial<Record<'Crossref' | 'DBLP' | 'OpenAlex' | 'DataCite', Work[]>>;
  fail?: Partial<Record<SourceName, Failure>>;
  unresolvable?: string[];
}

export function mockSources(data: MockData): Sources & { calls: string[] } {
  const calls: string[] = [];
  const recs = data.records ?? [];
  const src = (name: 'Crossref' | 'DataCite' | 'DBLP' | 'OpenAlex'): ScholarlySource => ({
    name,
    supportsDoiLookup: name !== 'DBLP',
    getSourceName: () => name,
    async lookupByDOI(doi: string): Promise<LookupResult<Work>> {
      calls.push(`${name}:doi:${doi}`);
      if (data.fail?.[name]) return { status: data.fail[name]! };
      const r = recs.find((x) => x.sourceRecords[0].source === name && sameDoi(x.doi, doi));
      return r ? { status: 'OK', value: r } : { status: 'NO RECORD FOUND' };
    },
    async searchWork(): Promise<LookupResult<Work[]>> {
      calls.push(`${name}:search`);
      if (data.fail?.[name]) return { status: data.fail[name]! };
      const list = data.search?.[name] ?? recs.filter((x) => x.sourceRecords[0].source === name);
      return list.length ? { status: 'OK', value: list } : { status: 'NO RECORD FOUND' };
    },
  });
  return {
    calls,
    crossref: src('Crossref'),
    datacite: src('DataCite'),
    dblp: src('DBLP'),
    openalex: src('OpenAlex'),
    arxiv: {
      async lookupById(id: string) {
        calls.push(`arXiv:${id}`);
        if (data.fail?.arXiv) return { status: data.fail.arXiv };
        const r = recs.find((x) => x.sourceRecords[0].source === 'arXiv' && x.arxivId === id);
        return r ? { status: 'OK', value: r } : { status: 'NO RECORD FOUND' };
      },
    },
    async resolveDoi(doi: string) {
      calls.push(`resolve:${doi}`);
      if (data.fail?.['DOI resolver']) return { status: data.fail['DOI resolver']! };
      if (data.unresolvable?.some((d) => sameDoi(d, doi))) return { status: 'NO RECORD FOUND', value: { exists: false } };
      return { status: 'OK', value: { exists: true, target: 'https://publisher.example/' + doi } };
    },
  };
}
