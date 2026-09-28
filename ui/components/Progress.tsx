import type { SourceStatus } from '../../core/models/types';
import { lookupInfo } from './State';

const verb = (op: string) => op.charAt(0).toLowerCase() + op.slice(1);

/** Streams each source request as it happens (PRD §46). */
export function Progress({ statuses, done }: { statuses: SourceStatus[]; done: boolean }) {
  return (
    <ol className="progress" aria-live="polite" aria-label="Lookup progress">
      <li className="progress-row">
        <span className="mark tone-good" aria-hidden="true">
          <span className="mark-glyph">✓</span>
        </span>
        <span>BibTeX parsed on this device</span>
      </li>
      {statuses.map((s, i) => {
        const info = lookupInfo(s.status);
        return (
          <li key={i} className={`progress-row ${s.status === 'PENDING' ? 'is-pending' : ''}`}>
            <span className={`mark tone-${info.tone}`} aria-hidden="true">
              <span className="mark-glyph">{info.glyph}</span>
            </span>
            <span>
              <strong>{s.source}</strong> {verb(s.operation)}: {info.text}
              {s.detail && s.status !== 'OK' && s.status !== 'PENDING' ? <span className="muted"> ({s.detail})</span> : null}
            </span>
          </li>
        );
      })}
      {!done && statuses.length === 0 ? (
        <li className="progress-row is-pending">
          <span className="mark tone-quiet" aria-hidden="true">
            <span className="mark-glyph">◌</span>
          </span>
          <span>Preparing lookups</span>
        </li>
      ) : null}
    </ol>
  );
}
