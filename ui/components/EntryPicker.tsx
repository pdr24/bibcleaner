import { useMemo, useState } from 'react';
import { filterChoices, type EntryChoice } from '../entries';

export function EntryPicker({
  label,
  origin,
  choices,
  errorCount,
  onPick,
  onBack,
}: {
  label: string;
  origin: string;
  choices: EntryChoice[];
  errorCount: number;
  onPick: (i: number) => void;
  onBack: () => void;
}) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => filterChoices(choices, q).slice(0, 500), [choices, q]);
  return (
    <section className="picker" aria-labelledby="pick-h">
      <h2 id="pick-h" className="picker-title">
        {origin === 'file' ? label : 'Multiple BibTeX entries detected'}
      </h2>
      <p className="muted">
        {origin === 'file' ? `${choices.length} entries.` : `Your selection has ${choices.length} entries.`} BibCleaner analyzes one entry
        at a time. Choose one.
        {errorCount
          ? ` ${errorCount} part${errorCount === 1 ? '' : 's'} of the text could not be parsed and ${errorCount === 1 ? 'was' : 'were'} skipped.`
          : ''}
      </p>
      {choices.length > 8 ? (
        <label className="search">
          <span className="sr-only">Filter entries</span>
          <input type="search" placeholder="Filter by key, title or year" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      ) : null}
      <ul className="entries">
        {shown.map((c) => (
          <li key={c.index}>
            <button type="button" className="entry" onClick={() => onPick(c.index)}>
              <span className="entry-key">{c.key || '(no key)'}</span>
              <span className="entry-title">{c.title ?? <span className="muted">No title</span>}</span>
              <span className="muted small">
                @{c.type}
                {c.year ? `, ${c.year}` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {shown.length === 0 ? <p className="muted">No entries match “{q}”.</p> : null}
      <button type="button" className="btn" onClick={onBack}>
        Back
      </button>
    </section>
  );
}
