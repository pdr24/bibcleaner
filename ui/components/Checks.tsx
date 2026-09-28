import type { CheckResult, FieldComparison } from '../../core/models/types';
import { StateMark } from './State';

export function Checks({ checks, urlAction }: { checks: CheckResult[]; urlAction?: React.ReactNode }) {
  if (!checks.length) return null;
  return (
    <section className="panel" aria-labelledby="checks-h">
      <h3 id="checks-h">Checks</h3>
      <ul className="checks">
        {checks.map((c) => (
          <li key={c.id + c.label} className="check">
            <StateMark state={c.state} compact />
            <div>
              <span>{c.label}</span>
              {c.detail ? <p className="muted small">{c.detail}</p> : null}
              {c.id === 'url' ? urlAction : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function FieldTable({ rows }: { rows: FieldComparison[] }) {
  if (!rows.length) return null;
  return (
    <section className="panel" aria-labelledby="fields-h">
      <details>
        <summary>
          <h3 id="fields-h">Field by field</h3>
          <span className="muted small">{rows.filter((r) => r.status === 'CONFLICT').length} conflicts</span>
        </summary>
        <div className="table-wrap">
          <table className="fields">
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Your entry</th>
                <th scope="col">Matched record</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <th scope="row">{r.field}</th>
                  <td className="bib">{r.input ?? <span className="muted">—</span>}</td>
                  <td className="bib">{r.authoritative ?? <span className="muted">—</span>}</td>
                  <td>
                    <StateMark state={r.status} />
                    {r.note ? <p className="muted small">{r.note}</p> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
