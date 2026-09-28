import { useState } from 'react';
import { lineDiff } from '../../core/diff/lineDiff';
import { copyText, downloadText, safeFilename } from '../platform';

type Tab = 'original' | 'cleaned' | 'diff';

export function Output({
  original,
  cleaned,
  entryKey,
  acceptedCount,
}: {
  original: string;
  cleaned: string;
  entryKey?: string;
  acceptedCount: number;
}) {
  const [tab, setTab] = useState<Tab>('cleaned');
  const [copied, setCopied] = useState<string | null>(null);
  const changed = original !== cleaned;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'original', label: 'Original' },
    { id: 'cleaned', label: 'Cleaned' },
    { id: 'diff', label: 'Diff' },
  ];
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setTab(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };
  const shown = tab === 'original' ? original : cleaned;
  return (
    <section className="output" aria-labelledby="out-h">
      <h3 id="out-h" className="sr-only">
        Result
      </h3>
      <div role="tablist" aria-label="Result view" className="tabs">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            aria-controls="out-panel"
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id="out-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="out-panel" tabIndex={0}>
        {tab === 'diff' ? (
          changed ? (
            <pre className="diff">
              {lineDiff(original, cleaned).map((l, i) => (
                <div key={i} className={`diff-${l.kind}`}>
                  <span className="diff-sign" aria-hidden="true">
                    {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                  </span>
                  <span className="sr-only">{l.kind === 'add' ? 'added: ' : l.kind === 'del' ? 'removed: ' : ''}</span>
                  {l.text || ' '}
                </div>
              ))}
            </pre>
          ) : (
            <p className="muted out-empty">No differences yet. Accept a suggestion to see it here.</p>
          )
        ) : (
          <pre className="bibout">{shown}</pre>
        )}
      </div>
      <div className="out-actions">
        <p className="muted small" aria-live="polite">
          {copied ??
            (acceptedCount
              ? `${acceptedCount} accepted change${acceptedCount === 1 ? '' : 's'} applied.`
              : 'No changes applied. The cleaned entry is identical to yours.')}
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={async () => {
            const ok = await copyText(tab === 'original' ? original : cleaned);
            setCopied(
              ok
                ? `Copied the ${tab === 'original' ? 'original' : 'cleaned'} entry.`
                : 'Copy failed. Select the text and copy it manually.',
            );
            setTimeout(() => setCopied(null), 2500);
          }}
        >
          Copy {tab === 'original' ? 'original' : 'BibTeX'}
        </button>
        <button type="button" className="btn" onClick={() => downloadText(safeFilename(entryKey), tab === 'original' ? original : cleaned)}>
          Download
        </button>
      </div>
    </section>
  );
}
