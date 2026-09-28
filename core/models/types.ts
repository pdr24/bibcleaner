/**
 * Canonical internal models. Every external source maps into `Work`;
 * matching/verification logic never sees source-specific field names.
 */

export type WorkType =
  | 'article'
  | 'inproceedings'
  | 'proceedings'
  | 'book'
  | 'inbook'
  | 'incollection'
  | 'phdthesis'
  | 'mastersthesis'
  | 'techreport'
  | 'misc'
  | 'online'
  | 'software'
  | 'dataset'
  | 'preprint';

export interface Author {
  /** Surname including particles ("van der Berg"). */
  family: string;
  /** Given names as written ("John A.", "J. A."). */
  given: string;
  /** Literal / corporate author that must not be split. */
  literal?: string;
}

export type SourceName = 'Crossref' | 'DataCite' | 'DBLP' | 'OpenAlex' | 'arXiv' | 'DOI resolver' | 'URL';

export interface SourceRecord {
  source: SourceName;
  /** Link a human can open to inspect the record. */
  recordUrl?: string;
  /** Source-native identifier (DBLP key, OpenAlex id, ...). */
  nativeId?: string;
  retrievedAt: number;
}

export interface Work {
  title?: string;
  authors: Author[];
  year?: number;
  venue?: string;
  /** Short venue label if the source provides one (e.g. DBLP "CHI"). */
  venueShort?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  url?: string;
  isbn?: string[];
  issn?: string[];
  arxivId?: string;
  type?: WorkType;
  /** true when the record is a preprint (arXiv, CoRR, posted-content). */
  isPreprint?: boolean;
  /** Versions this record says it relates to (e.g. arXiv's published DOI). */
  relatedDois?: string[];
  sourceRecords: SourceRecord[];
}

export type VerificationState =
  'VERIFIED' | 'HIGH CONFIDENCE' | 'AMBIGUOUS' | 'UNVERIFIED' | 'CONFLICT' | 'UNREACHABLE' | 'NOT CHECKED' | 'MISSING';

export type Confidence = 'VERY HIGH' | 'HIGH' | 'POSSIBLE' | 'LOW';

/** Outcome of a single request to an external source. */
export type LookupStatus = 'OK' | 'NO RECORD FOUND' | 'LOOKUP FAILED' | 'RATE LIMITED' | 'NETWORK UNAVAILABLE';

export interface LookupResult<T> {
  status: LookupStatus;
  value?: T;
  detail?: string;
}

export interface Evidence {
  source: SourceName | 'Current BibTeX';
  value?: string;
  recordUrl?: string;
  agrees?: boolean;
}

export type SuggestionPatch =
  | { kind: 'set'; value: string }
  | { kind: 'wrap'; term: string }
  | { kind: 'rename'; to: string }
  | { kind: 'remove' }
  | { kind: 'layout' };

export type SuggestionCategory = 'conflict' | 'missing' | 'format' | 'version' | 'key' | 'url';

export interface Suggestion {
  id: string;
  /** BibTeX field name, or ENTRYTYPE / KEY / ENTRY. */
  field: string;
  operation: 'add' | 'replace' | 'format' | 'rename' | 'remove';
  category: SuggestionCategory;
  patch: SuggestionPatch;
  title: string;
  originalValue?: string;
  suggestedValue: string;
  confidence: Confidence;
  reason: string;
  sources: Evidence[];
  /** Suggestions sharing a group are alternatives; accepting one rejects the others. */
  group?: string;
  warning?: string;
  accepted: boolean | null;
}

export interface FieldComparison {
  field: string;
  input?: string;
  authoritative?: string;
  status: VerificationState;
  note?: string;
  evidence: Evidence[];
}

export interface CandidateScore {
  total: number;
  components: Partial<Record<'title' | 'authors' | 'venue' | 'year' | 'publisher' | 'identifier', number>>;
  identifierMatch: boolean;
  criticalContradictions: string[];
  confidence: Confidence;
  state: VerificationState;
}

export interface Candidate {
  id: string;
  /** Merged view (highest-precedence value per field). */
  work: Work;
  /** The individual source records merged into this candidate. */
  records: Work[];
  score: CandidateScore;
  /** Candidates describing the same paper in another form (preprint / published). */
  versionGroup: string;
}

export interface CheckResult {
  id: string;
  label: string;
  state: VerificationState;
  detail?: string;
}

export interface SourceStatus {
  source: SourceName;
  operation: string;
  status: LookupStatus | 'PENDING' | 'SKIPPED';
  detail?: string;
}
