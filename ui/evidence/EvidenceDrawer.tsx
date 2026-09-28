import type { Suggestion } from '../../core/models/types';
import { confidenceText } from '../components/State';

const safeHref = (u?: string) => (u && /^https?:\/\//i.test(u) ? u : undefined);

/** "Why this change?" — compact provenance for one suggestion (PRD §29). */
export function EvidenceDrawer({ s }: { s: Suggestion }) {
  const current = s.originalValue;
  return (
    <div className="evidence">
      <p className="evidence-reason">{s.reason}</p>
      {s.sources.length > 0 || current !== undefined ? (
        <table className="evidence-table">
          <caption className="sr-only">Evidence for this change</caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Value</th>
              <th scope="col">
                <span className="sr-only">Agreement</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {s.sources
              .filter((e) => e.source !== 'Current BibTeX')
              .map((e, i) => {
                const href = safeHref(e.recordUrl);
                return (
                  <tr key={i}>
                    <th scope="row">
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer">
                          {e.source}
                        </a>
                      ) : (
                        e.source
                      )}
                    </th>
                    <td className="bib">{e.value ?? '—'}</td>
                    <td>
                      {e.agrees === false ? (
                        <span className="tone-warn">differs from your entry</span>
                      ) : e.agrees ? (
                        <span className="tone-good">same as your entry</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            {current !== undefined ? (
              <tr className="evidence-current">
                <th scope="row">Your BibTeX</th>
                <td className="bib">{current || '—'}</td>
                <td />
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : (
        <p className="muted">This is a formatting rule, so no external source is involved.</p>
      )}
      <p className="evidence-conf">{confidenceText(s.confidence)}</p>
    </div>
  );
}
