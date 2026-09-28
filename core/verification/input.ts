import type { Work, WorkType } from '../models/types';
import type { BibEntry, ValuePart } from '../parser/bibtex';
import { fieldText, getField, inheritedFields, valueToText } from '../parser/bibtex';
import { latexToUnicode } from '../normalize/latex';
import { findDoiInText, parseDoi } from '../normalize/doi';
import { parseAuthorField } from '../normalize/authors';
import { isPreprintVenue } from '../normalize/venue';
import { parseArxivId } from '../../sources/arxiv/adapter';

export interface InputCitation {
  entry: BibEntry;
  strings: Map<string, ValuePart[]>;
  /** Plain (macro-expanded, still LaTeX) text per lower-cased field name, incl. inherited. */
  fields: Map<string, string>;
  inherited: Set<string>;
  work: Work;
  authorsTruncated: boolean;
  /** The citation itself points at a preprint (arXiv eprint, CoRR, arXiv DOI...). */
  citesPreprint: boolean;
  /** Raw DOI text as written, if any. */
  rawDoi?: string;
}

export function normalizeType(t: string): WorkType | string {
  const x = t.toLowerCase();
  if (x === 'conference') return 'inproceedings';
  if (x === 'electronic' || x === 'www') return 'online';
  if (x === 'thesis') return 'phdthesis';
  if (x === 'report') return 'techreport';
  return x;
}

export function venueFieldFor(type: string): 'journal' | 'booktitle' | 'publisher' | 'school' | 'institution' | 'howpublished' {
  switch (normalizeType(type)) {
    case 'article':
      return 'journal';
    case 'inproceedings':
    case 'incollection':
    case 'inbook':
      return 'booktitle';
    case 'phdthesis':
    case 'mastersthesis':
      return 'school';
    case 'techreport':
      return 'institution';
    case 'book':
    case 'proceedings':
      return 'publisher';
    default:
      return 'howpublished';
  }
}

export function buildInput(entry: BibEntry, strings: Map<string, ValuePart[]>, allEntries: BibEntry[] = []): InputCitation {
  const fields = new Map<string, string>();
  for (const f of entry.fields) {
    const name = f.name.toLowerCase();
    if (!fields.has(name)) fields.set(name, valueToText(f.parts, strings).text);
  }
  const inherited = new Set<string>();
  for (const [k, v] of inheritedFields(entry, allEntries, strings)) {
    fields.set(k, v);
    inherited.add(k);
  }
  const get = (n: string) => fields.get(n);
  const authorField = parseAuthorField(get('author'));
  const rawDoi = get('doi');
  const doi = parseDoi(rawDoi)?.doi ?? (rawDoi ? undefined : (findDoiInText(get('url')) ?? undefined));

  let arxivId: string | undefined;
  const eprint = get('eprint');
  const archive = (get('archiveprefix') ?? get('eprinttype') ?? '').toLowerCase();
  if (eprint && (archive === 'arxiv' || parseArxivId(eprint))) arxivId = parseArxivId(eprint) ?? undefined;
  if (!arxivId) {
    for (const k of ['journal', 'howpublished', 'note', 'url', 'booktitle']) {
      const v = get(k);
      const m = v?.match(/arxiv(?:\.org\/(?:abs|pdf)\/|:\s*|\s+preprint\s+arxiv:\s*)([a-z-]+\/\d{7}|\d{4}\.\d{4,5})/i);
      if (m) {
        arxivId = m[1];
        break;
      }
    }
  }
  if (!arxivId && doi && /^10\.48550\/arxiv\./i.test(doi)) arxivId = doi.replace(/^10\.48550\/arxiv\./i, '');

  const venueRaw = get('journal') ?? get('booktitle') ?? get('howpublished') ?? get('series');
  const yearText = get('year') ?? get('date')?.slice(0, 4);
  const yearNum = yearText && /^\d{4}$/.test(yearText.trim()) ? Number(yearText.trim()) : undefined;
  const citesPreprint = (!!arxivId && (!doi || /^10\.48550\//i.test(doi))) || isPreprintVenue(venueRaw) || entry.type === 'preprint';

  const work: Work = {
    title: get('title') ? latexToUnicode(get('title')!) : undefined,
    authors: authorField.authors,
    year: yearNum,
    venue: venueRaw ? latexToUnicode(venueRaw) : undefined,
    publisher: get('publisher') ? latexToUnicode(get('publisher')!) : undefined,
    volume: get('volume'),
    issue: get('number') ?? get('issue'),
    pages: get('pages'),
    doi,
    url: get('url'),
    arxivId,
    type: normalizeType(entry.type) as WorkType,
    isPreprint: citesPreprint,
    sourceRecords: [],
  };
  return { entry, strings, fields, inherited, work, authorsTruncated: authorField.truncated, citesPreprint, rawDoi };
}

export { getField, fieldText };
