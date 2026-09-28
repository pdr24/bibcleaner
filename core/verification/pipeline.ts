import type { CheckResult, LookupResult, SourceName, SourceStatus, Work } from '../models/types';
import type { BibEntry, ParseError, ValuePart } from '../parser/bibtex';
import { parseBibtex } from '../parser/bibtex';
import { buildInput, type InputCitation } from './input';
import { structuralChecks } from './structural';
import { parseDoi } from '../normalize/doi';
import { scoreCandidate } from '../confidence/score';
import { THRESHOLDS } from '../confidence/config';
import { buildCandidates, type CandidateSet } from '../matcher/candidates';
import type { ScholarlySource, WorkQuery } from '../../sources/types';
import type { DoiResolution } from '../../sources/doiResolver';
import type { Mode } from './evaluate';

export interface Sources {
  crossref: ScholarlySource;
  datacite: ScholarlySource;
  dblp: ScholarlySource;
  openalex: ScholarlySource;
  arxiv: { lookupById(id: string): Promise<LookupResult<Work>> };
  resolveDoi(doi: string): Promise<LookupResult<DoiResolution>>;
}

export type Progress = (statuses: SourceStatus[]) => void;

export interface Analysis {
  entryText: string;
  entry?: BibEntry;
  input?: InputCitation;
  parseErrors: ParseError[];
  structural: CheckResult[];
  statuses: SourceStatus[];
  doiChecks: CheckResult[];
  records: Work[];
  candidateSet: CandidateSet;
  /** Sources that could not be consulted (distinct from sources that disagreed). */
  unavailable: SourceName[];
}

export interface AnalyzeOptions {
  mode: Mode;
  /** Other entries and @string macros from the same .bib file, if any. */
  context?: { entries: BibEntry[]; strings: Map<string, ValuePart[]> };
}

const failed = (s: string) => s === 'LOOKUP FAILED' || s === 'RATE LIMITED' || s === 'NETWORK UNAVAILABLE';

export async function analyze(
  entryText: string,
  opts: AnalyzeOptions,
  sources: Sources,
  onProgress: Progress = () => {},
): Promise<Analysis> {
  const parsed = parseBibtex(entryText);
  const strings = new Map([...(opts.context?.strings ?? []), ...parsed.strings]);
  const entry = parsed.entries[0];
  const analysis: Analysis = {
    entryText,
    entry,
    parseErrors: parsed.errors,
    structural: structuralChecks(entry, parsed.errors, strings),
    statuses: [],
    doiChecks: [],
    records: [],
    candidateSet: { candidates: [], selectedId: null, ambiguous: false },
    unavailable: [],
  };
  if (!entry) return analysis;
  const input = buildInput(entry, strings, opts.context?.entries ?? []);
  analysis.input = input;

  const statuses = analysis.statuses;
  const track = async <T>(source: SourceName, operation: string, fn: () => Promise<LookupResult<T>>): Promise<LookupResult<T>> => {
    const st: SourceStatus = { source, operation, status: 'PENDING' };
    statuses.push(st);
    onProgress([...statuses]);
    // An adapter that throws (malformed response, unexpected shape) must never
    // abort the analysis: it is treated exactly like an unreachable source.
    let r: LookupResult<T>;
    try {
      r = await fn();
    } catch (e) {
      r = { status: 'LOOKUP FAILED', detail: `${source} returned something unusable (${(e as Error)?.message ?? 'error'}).` };
    }
    st.status = r.status;
    st.detail = r.detail;
    if (failed(r.status) && !analysis.unavailable.includes(source)) analysis.unavailable.push(source);
    onProgress([...statuses]);
    return r;
  };
  const records = analysis.records;
  const addRecords = (ws: Work[] | undefined) => {
    for (const w of ws ?? []) records.push(w);
  };
  const isStrong = (w: Work) => {
    const s = scoreCandidate(input.work, w, { inputAuthorsTruncated: input.authorsTruncated });
    return s.total >= THRESHOLDS.high && s.criticalContradictions.length === 0;
  };
  const query: WorkQuery = { title: input.work.title, authors: input.work.authors, year: input.work.year, venue: input.work.venue };
  const searched = new Set<string>();
  const search = async (src: ScholarlySource) => {
    if (searched.has(src.name) || !query.title) return;
    searched.add(src.name);
    const r = await track(src.name, 'Search by title', () => src.searchWork(query));
    if (r.status === 'OK') addRecords(r.value);
  };

  // ---- DOI verification (levels 1–4) ----
  const rawDoi = input.rawDoi;
  let doiRecord: Work | undefined;
  if (rawDoi !== undefined) {
    const pd = parseDoi(rawDoi);
    analysis.doiChecks.push(
      pd
        ? { id: 'doi-syntax', label: 'DOI syntax valid', state: 'VERIFIED' }
        : {
            id: 'doi-syntax',
            label: 'DOI is not a valid DOI',
            state: 'CONFLICT',
            detail: `"${rawDoi}" does not look like 10.prefix/suffix.`,
          },
    );
    if (pd) {
      const [res, meta] = await Promise.all([
        track('DOI resolver', 'Resolve DOI', () => sources.resolveDoi(pd.doi)),
        (async () => {
          const cr = await track('Crossref', 'Look up DOI', () => sources.crossref.lookupByDOI(pd.doi));
          if (cr.status === 'OK') return { r: cr, src: 'Crossref' as const };
          // Not a Crossref DOI (or Crossref unavailable): DataCite covers arXiv, datasets, many repositories.
          const dc = await track('DataCite', 'Look up DOI', () => sources.datacite.lookupByDOI(pd.doi));
          if (dc.status === 'OK') return { r: dc, src: 'DataCite' as const };
          return { r: failed(cr.status) ? cr : dc, src: undefined };
        })(),
      ]);
      if (res.status === 'OK')
        analysis.doiChecks.push({
          id: 'doi-resolve',
          label: 'DOI resolves',
          state: 'VERIFIED',
          detail: res.value?.target ? `Resolves to ${res.value.target}` : undefined,
        });
      else if (res.status === 'NO RECORD FOUND')
        analysis.doiChecks.push({
          id: 'doi-resolve',
          label: 'DOI does not resolve',
          state: 'CONFLICT',
          detail: 'doi.org does not recognise this DOI.',
        });
      else
        analysis.doiChecks.push({
          id: 'doi-resolve',
          label: 'DOI resolution not checked',
          state: 'NOT CHECKED',
          detail: `doi.org: ${res.status.toLowerCase()} (${res.detail ?? ''}). This says nothing about whether the DOI is correct.`,
        });

      if (meta.r.status === 'OK' && meta.r.value) {
        doiRecord = meta.r.value;
        addRecords([doiRecord]);
        analysis.doiChecks.push({ id: 'doi-meta', label: `DOI metadata retrieved from ${meta.src}`, state: 'VERIFIED' });
        const s = scoreCandidate(input.work, doiRecord, { inputAuthorsTruncated: input.authorsTruncated });
        const conflict = s.criticalContradictions.some((c) => c.startsWith('The DOI belongs'));
        analysis.doiChecks.push({
          id: 'doi-identity',
          label: conflict
            ? 'DOI belongs to a different work'
            : s.state === 'VERIFIED'
              ? 'DOI matches this citation'
              : s.state === 'HIGH CONFIDENCE'
                ? 'DOI very likely matches this citation'
                : 'DOI identity uncertain',
          state: conflict ? 'CONFLICT' : s.state,
          detail: conflict ? `The DOI is registered for "${doiRecord.title}".` : s.criticalContradictions.join(' ') || undefined,
        });
      } else if (meta.r.status === 'NO RECORD FOUND') {
        analysis.doiChecks.push({
          id: 'doi-meta',
          label: 'No metadata record for this DOI',
          state: 'UNVERIFIED',
          detail: 'Neither Crossref nor DataCite has this DOI.',
        });
      } else {
        analysis.doiChecks.push({
          id: 'doi-meta',
          label: 'DOI metadata not checked',
          state: 'NOT CHECKED',
          detail: `Lookup ${meta.r.status.toLowerCase()}. A source being unavailable is not evidence the DOI is wrong.`,
        });
      }
    }
  }

  // ---- arXiv identifier ----
  if (input.work.arxivId) {
    const ax = await track('arXiv', 'Look up arXiv ID', () => sources.arxiv.lookupById(input.work.arxivId!));
    if (ax.status === 'OK' && ax.value) {
      addRecords([ax.value]);
      // arXiv lists the published DOI when authors add it.
      for (const d of ax.value.relatedDois ?? []) {
        const cr = await track('Crossref', 'Look up published DOI', () => sources.crossref.lookupByDOI(d));
        if (cr.status === 'OK') addRecords([cr.value!]);
      }
    }
  }

  // ---- Discovery (tiered, stop early when strong) ----
  const strongNow = () => records.some(isStrong);
  const wantsPublished = input.citesPreprint || records.some((r) => isStrong(r) && r.isPreprint);
  if (!strongNow() || wantsPublished) {
    await search(sources.crossref);
    if (!records.some((r) => isStrong(r) && !r.isPreprint) || wantsPublished) await search(sources.dblp);
    if (!strongNow()) await search(sources.openalex);
  }
  // Corroborate with DBLP (CS-authoritative; gives venue abbreviations) when cleaning.
  if (opts.mode === 'clean' && query.title) await search(sources.dblp);
  if (!strongNow() && !rawDoi) await search(sources.datacite);

  analysis.candidateSet = buildCandidates(input, records);
  onProgress([...statuses]);
  return analysis;
}

export { parseBibtex };
