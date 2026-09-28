import { CrossrefAdapter } from './crossref/adapter';
import { DataCiteAdapter } from './datacite/adapter';
import { DBLPAdapter } from './dblp/adapter';
import { OpenAlexAdapter } from './openalex/adapter';
import { ArxivAdapter } from './arxiv/adapter';
import { resolveDoi } from './doiResolver';
import type { Sources } from '../core/verification/pipeline';

export function defaultSources(): Sources {
  return {
    crossref: new CrossrefAdapter(),
    datacite: new DataCiteAdapter(),
    dblp: new DBLPAdapter(),
    openalex: new OpenAlexAdapter(),
    arxiv: new ArxivAdapter(),
    resolveDoi,
  };
}
