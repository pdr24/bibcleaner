import { useState } from 'react';
import type { Suggestion } from '../../core/models/types';
import { EvidenceDrawer } from '../evidence/EvidenceDrawer';
import { confidenceText } from '../components/State';
import { bySection, counts, needsOwnDecision, type Decision } from './review';

const FIELD_LABEL: Record<string, string> = { KEY: 'citation key', ENTRYTYPE: 'entry type', ENTRY: 'whole entry' };

function Choice({ s, onDecide }: { s: Suggestion; onDecide: (v: Decision) => void }) {
  const name = `decide-${s.id}`;
  return (
    <fieldset className="choice">
      <legend className="sr-only">Decision for: {s.title}</legend>
      <label className={`choice-opt ${s.accepted === true ? 'is-on accept' : ''}`}>
        <input type="radio" name={name} checked={s.accepted === true} onChange={() => onDecide(true)} />
        Accept
      </label>
      <label className={`choice-opt ${s.accepted === false ? 'is-on reject' : ''}`}>
        <input type="radio" name={name} checked={s.accepted === false} onChange={() => onDecide(false)} />
        Reject
      </label>
      {s.accepted !== null ? (
        <button type="button" className="linkish" onClick={() => onDecide(null)}>
          Undo
        </button>
      ) : null}
    </fieldset>
  );
}

function Item({
  s,
  onDecide,
  skipped,
  hasAlternatives,
}: {
  s: Suggestion;
  onDecide: (v: Decision) => void;
  skipped?: string;
  hasAlternatives: boolean;
}) {
  const [open, setOpen] = useState(false);
  const layout = s.patch.kind === 'layout';
  return (
    <li id={`sg-${s.id}`} className={`sg ${s.accepted === true ? 'is-accepted' : s.accepted === false ? 'is-rejected' : ''}`} tabIndex={-1}>
      <div className="sg-head">
        <div className="sg-title">
          <h4>{s.title}</h4>
          <span className="sg-field">{FIELD_LABEL[s.field] ?? s.field}</span>
        </div>
        <Choice s={s} onDecide={onDecide} />
      </div>
      {layout ? (
        <p className="sg-note">{s.suggestedValue}. See the Diff tab after accepting.</p>
      ) : (
        <div className="sg-change">
          <div className="sg-before">
            <span className="sr-only">Current value: </span>
            {s.operation === 'add' ? <span className="muted">not present</span> : <code className="bib">{s.originalValue || '—'}</code>}
          </div>
          <span className="sg-arrow" aria-hidden="true">
            ⟶
          </span>
          <div className="sg-after">
            <span className="sr-only">Suggested value: </span>
            {s.operation === 'remove' ? <span className="muted">remove field</span> : <code className="bib">{s.suggestedValue}</code>}
          </div>
        </div>
      )}
      <div className="sg-meta">
        <span>{s.category === 'format' || s.category === 'key' ? 'Formatting' : confidenceText(s.confidence)}</span>
        {hasAlternatives ? (
          <span className="muted">Alternative to another suggestion for this field; accepting one rejects the other</span>
        ) : null}
        <button type="button" className="linkish" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide why' : 'Why?'}
        </button>
      </div>
      {s.warning ? <p className="sg-warning">{s.warning}</p> : null}
      {skipped ? <p className="sg-warning">Not applied: {skipped}</p> : null}
      {open ? <EvidenceDrawer s={s} /> : null}
    </li>
  );
}

export function SuggestionList({
  suggestions,
  onDecide,
  onAcceptAll,
  onRejectAll,
  onVersion,
  skipped,
}: {
  suggestions: Suggestion[];
  onDecide: (id: string, v: Decision) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onVersion: (v: Decision) => void;
  skipped: Map<string, string>;
}) {
  if (suggestions.length === 0) {
    return (
      <section className="panel" aria-labelledby="sg-h">
        <h3 id="sg-h">Suggested changes</h3>
        <p className="muted">Nothing to change. Your entry is unchanged in the output.</p>
      </section>
    );
  }
  const c = counts(suggestions);
  const groupSize = new Map<string, number>();
  for (const s of suggestions) if (s.group) groupSize.set(s.group, (groupSize.get(s.group) ?? 0) + 1);
  const held = suggestions.filter((s) => needsOwnDecision(s)).length;
  return (
    <section className="panel" aria-labelledby="sg-h">
      <div className="panel-head">
        <h3 id="sg-h">Suggested changes</h3>
        <p className="tally" aria-live="polite">
          {c.accepted} accepted, {c.rejected} rejected, {c.undecided} undecided
        </p>
      </div>
      <div className="bulk">
        <button type="button" className="btn" onClick={onAcceptAll}>
          Accept all
        </button>
        <button type="button" className="btn" onClick={onRejectAll}>
          Reject all
        </button>
        {held > 0 ? <span className="muted">Citation key and published-version changes are not included in Accept all.</span> : null}
      </div>
      {bySection(suggestions).map((sec) => (
        <div key={sec.id} className={`sg-section sec-${sec.id}`}>
          <h4 className="sg-section-title">{sec.title}</h4>
          <p className="muted small">{sec.blurb}</p>
          {sec.id === 'version' ? (
            <div className="bulk">
              <button type="button" className="btn" onClick={() => onVersion(true)}>
                Convert to published version
              </button>
              <button type="button" className="btn" onClick={() => onVersion(false)}>
                Keep citing the preprint
              </button>
            </div>
          ) : null}
          <ul className="sg-list">
            {sec.items.map((s) => (
              <Item
                key={s.id}
                s={s}
                onDecide={(v) => onDecide(s.id, v)}
                skipped={skipped.get(s.id)}
                hasAlternatives={!!s.group && (groupSize.get(s.group) ?? 0) > 1}
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
