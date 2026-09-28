import type { Candidate, SourceName, SourceStatus } from '../../core/models/types';
import type { CandidateSet } from '../../core/matcher/candidates';
import { authorDisplay } from '../../core/normalize/authors';
import { latexToUnicode } from '../../core/normalize/latex';
import { StateMark } from './State';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const sourcesOf = (c: Candidate) => [...new Set(c.records.map((r) => r.sourceRecords[0]?.source).filter(Boolean))].join(', ');

function Meta({ c }: { c: Candidate }) {
  const w = c.work;
  const authors =
    w.authors
      .slice(0, 4)
      .map((a) => latexToUnicode(authorDisplay(a)))
      .join(', ') + (w.authors.length > 4 ? ` and ${w.authors.length - 4} more` : '');
  return (
    <p className="work-meta">
      {authors ? <span>{authors}. </span> : null}
      {w.venue ? <span className="work-venue">{w.venue}</span> : null}
      {w.year ? <span>, {w.year}</span> : null}
      {w.isPreprint ? <span className="tag">preprint</span> : null}
    </p>
  );
}

const REASON: Record<string, string> = {
  'RATE LIMITED': 'rate limited',
  'NETWORK UNAVAILABLE': 'no network',
  'LOOKUP FAILED': 'lookup failed',
};

/** "HTTP 400", "Timed out", "Expected JSON but received an HTML page"… */
const detailOf = (s?: SourceStatus) => (s?.detail ? s.detail.replace(/\.$/, '') : undefined);

export function MatchSummary({
  set,
  candidate,
  unavailable,
  statuses = [],
}: {
  set: CandidateSet;
  candidate: Candidate | null;
  unavailable: SourceName[];
  statuses?: SourceStatus[];
}) {
  const doi = candidate?.work.doi;
  // Every source unreachable and no candidate: the citation was not checked,
  // which is different from having been checked and not found (Rule 4).
  const nothingChecked = unavailable.length > 0 && set.candidates.length === 0 && statuses.every((s) => s.status !== 'OK');
  const withReason = unavailable.map((src) => {
    const why = statuses.find((s) => s.source === src && REASON[s.status]);
    if (!why) return src;
    // "rate limited" and "no network" explain themselves; "lookup failed" does
    // not, so that one carries the detail (HTTP 400, timed out, HTML page…).
    const detail = why.status === 'LOOKUP FAILED' ? detailOf(why) : undefined;
    return `${src} (${detail ?? REASON[why.status]})`;
  });
  return (
    <section className="match" aria-labelledby="match-h">
      <div className="match-state">
        {candidate ? <StateMark state={candidate.score.state} /> : <StateMark state={set.ambiguous ? 'AMBIGUOUS' : 'UNVERIFIED'} />}
        {candidate ? <span className="muted">match score {pct(candidate.score.total)}</span> : null}
      </div>
      <h2 id="match-h" className="work-title">
        {candidate
          ? latexToUnicode(candidate.work.title ?? candidate.work.doi ?? 'Untitled record')
          : set.ambiguous
            ? 'Several publications could match'
            : nothingChecked
              ? 'This citation could not be checked'
              : 'No matching publication found'}
      </h2>
      {candidate ? <Meta c={candidate} /> : null}
      {!candidate && !set.ambiguous ? (
        <p className="muted">
          {nothingChecked
            ? 'No scholarly service could be reached, so nothing about this citation was verified. Structure and formatting were still checked on this device.'
            : `BibCleaner did not find a record similar enough to trust. Nothing will be changed unless you choose to. ${set.message ?? ''}`}
        </p>
      ) : null}
      {candidate?.score.criticalContradictions.length ? (
        <ul className="contradictions">
          {candidate.score.criticalContradictions.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      ) : null}
      {doi ? (
        <p className="work-doi">
          DOI{' '}
          <a href={`https://doi.org/${encodeURIComponent(doi).replace(/%2F/g, '/')}`} target="_blank" rel="noopener noreferrer">
            {doi}
          </a>
          {candidate ? <span className="muted"> from {sourcesOf(candidate)}</span> : null}
        </p>
      ) : null}
      {unavailable.length ? (
        <p className="unavailable" role="note">
          {withReason.join(', ')} could not be checked. A source that could not be reached is not evidence against your citation.
        </p>
      ) : null}
    </section>
  );
}

/** Candidate selection when matches are ambiguous or the user wants another record (PRD §24). */
export function CandidatePicker({
  set,
  selectedId,
  onSelect,
}: {
  set: CandidateSet;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (set.candidates.length === 0) return null;
  if (set.candidates.length === 1 && !set.ambiguous) return null;
  return (
    <section className={`panel ${set.ambiguous ? 'is-attention' : ''}`} aria-labelledby="cand-h">
      <h3 id="cand-h">{set.ambiguous ? `${set.candidates.length} possible matches. Choose the one you meant.` : 'Other records found'}</h3>
      {set.ambiguous ? (
        <p className="muted small">These scores are too close to pick one safely, so no suggestions are made until you choose.</p>
      ) : null}
      <fieldset className="cands">
        <legend className="sr-only">Matching publication</legend>
        {set.candidates.map((c) => (
          <label key={c.id} className={`cand ${selectedId === c.id ? 'is-on' : ''}`}>
            <input type="radio" name="cand" checked={selectedId === c.id} onChange={() => onSelect(c.id)} />
            <span className="cand-body">
              <span className="cand-title">{latexToUnicode(c.work.title ?? c.work.doi ?? 'Untitled')}</span>
              <span className="muted small">
                {[c.work.venueShort ?? c.work.venue, c.work.year, c.work.isPreprint ? 'preprint' : null].filter(Boolean).join(', ')}. Found
                in {sourcesOf(c)}.{set.versions?.publishedId === c.id ? ' Published version.' : ''}
              </span>
            </span>
            <span className="cand-score">{pct(c.score.total)}</span>
          </label>
        ))}
        <label className={`cand ${selectedId === null ? 'is-on' : ''}`}>
          <input type="radio" name="cand" checked={selectedId === null} onChange={() => onSelect(null)} />
          <span className="cand-body">
            <span className="cand-title">None of these</span>
            <span className="muted small">Check structure and formatting only.</span>
          </span>
        </label>
      </fieldset>
    </section>
  );
}
