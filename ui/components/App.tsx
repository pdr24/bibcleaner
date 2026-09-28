import { useEffect, useMemo, useState } from 'react';
import { useBibCleaner } from '../useBibCleaner';
import { isPopup, openInTab, takePendingSelection } from '../platform';
import { InputView } from './InputView';
import { EntryPicker } from './EntryPicker';
import { Progress } from './Progress';
import { CandidatePicker, MatchSummary } from './Match';
import { ProofSheet } from './ProofSheet';
import { Checks, FieldTable } from './Checks';
import { Output } from './Output';
import { SettingsView } from './SettingsView';
import { SuggestionList } from '../review/SuggestionList';
import { counts } from '../review/review';
import { StateMark } from './State';

export function App() {
  const c = useBibCleaner();
  const [showSettings, setShowSettings] = useState(false);
  const popup = isPopup();

  useEffect(() => {
    void takePendingSelection().then((text) => {
      if (text) c.load(text, 'selection', 'Selected text');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const jump = (id: string) => {
    const el = document.getElementById(`sg-${id}`);
    el?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    el?.focus({ preventScroll: true });
  };

  const skipped = useMemo(() => new Map((c.result?.skipped ?? []).map((s) => [s.id, s.reason])), [c.result]);
  const a = c.analysis;
  const ev = c.evaluation;
  const url = a?.input?.fields.get('url');
  const versions = a?.candidateSet.versions;
  const allChecks = [...(a?.structural ?? []), ...(ev?.checks ?? [])];

  return (
    <div className={`app ${popup ? 'is-popup' : 'is-tab'}`}>
      <header className="bar">
        <h1 className="brand">
          <span className="brand-mark" aria-hidden="true">
            {'{'}✓{'}'}
          </span>
          BibCleaner
        </h1>
        <fieldset className="mode" disabled={c.phase === 'running'}>
          <legend className="sr-only">Mode</legend>
          <label className={c.settings.mode === 'verify' ? 'is-on' : ''}>
            <input type="radio" name="mode" checked={c.settings.mode === 'verify'} onChange={() => void c.setMode('verify')} />
            Verify
          </label>
          <label className={c.settings.mode === 'clean' ? 'is-on' : ''}>
            <input type="radio" name="mode" checked={c.settings.mode === 'clean'} onChange={() => void c.setMode('clean')} />
            Clean &amp; enrich
          </label>
        </fieldset>
        <div className="bar-actions">
          {popup ? (
            <button type="button" className="linkish" onClick={() => openInTab()}>
              Open in a tab
            </button>
          ) : null}
          <button type="button" className="linkish" aria-expanded={showSettings} onClick={() => setShowSettings(!showSettings)}>
            Settings
          </button>
        </div>
      </header>

      <main className="main">
        {showSettings ? (
          <SettingsView settings={c.settings} onSave={(s) => void c.updateSettings(s)} onClose={() => setShowSettings(false)} />
        ) : c.phase === 'input' ? (
          <InputView
            draft={c.draft}
            setDraft={c.setDraft}
            notice={c.notice}
            analyzeLabel={c.settings.mode === 'verify' ? 'Verify' : 'Analyze'}
            onAnalyze={() => c.load(c.draft, 'paste', 'Pasted text')}
            onFile={(text, name) => c.load(text, 'file', name)}
          />
        ) : c.phase === 'pick' && c.loaded ? (
          <EntryPicker
            label={c.loaded.label}
            origin={c.loaded.origin}
            choices={c.loaded.list.choices}
            errorCount={c.loaded.list.errorCount}
            onPick={c.pickEntry}
            onBack={c.startOver}
          />
        ) : c.phase === 'running' ? (
          <section className="running" aria-busy="true">
            <h2 className="running-title">Checking your entry</h2>
            <Progress statuses={c.statuses} done={false} />
          </section>
        ) : a && !a.input ? (
          <section className="panel">
            <h2>This entry could not be parsed</h2>
            <Checks checks={a.structural} />
            <p className="muted">Nothing was sent to any service. Fix the problem above and try again.</p>
            <button type="button" className="btn" onClick={c.startOver}>
              Edit entry
            </button>
          </section>
        ) : a && ev && c.result ? (
          <div className="results">
            <div className="col-main">
              <MatchSummary set={a.candidateSet} candidate={c.candidate} unavailable={a.unavailable} statuses={c.statuses} />
              {versions && a.input?.citesPreprint && c.candidateId === versions.publishedId ? (
                <p className="version-note" role="note">
                  Your entry cites a preprint, and a published version exists. Nothing converts it unless you choose to under{' '}
                  <a href="#sg-h">Published version</a>.
                </p>
              ) : null}
              <CandidatePicker set={a.candidateSet} selectedId={c.candidateId} onSelect={c.setCandidateId} />
              {a.entry ? (
                <ProofSheet text={a.entryText} entry={a.entry} comparisons={ev.comparisons} suggestions={c.suggestions} onJump={jump} />
              ) : null}
              <Checks
                checks={allChecks}
                urlAction={
                  url && (!c.urlCheck || c.urlCheck.state === 'NOT CHECKED') ? (
                    <button type="button" className="btn btn-small" disabled={c.urlChecking} onClick={() => void c.runUrlCheck()}>
                      {c.urlChecking ? 'Checking URL…' : 'Check URL'}
                    </button>
                  ) : null
                }
              />
              <SuggestionList
                suggestions={c.suggestions}
                onDecide={c.decideOne}
                onAcceptAll={c.acceptAll}
                onRejectAll={c.rejectAll}
                onVersion={c.setVersion}
                skipped={skipped}
              />
              <FieldTable rows={ev.comparisons} />
              <details className="panel sources">
                <summary>
                  <h3>Sources consulted</h3>
                </summary>
                <Progress statuses={c.statuses} done />
              </details>
            </div>
            <aside className="col-side">
              <Output
                original={a.entryText}
                cleaned={c.result.text}
                entryKey={a.entry?.key}
                acceptedCount={counts(c.suggestions).accepted}
              />
              <div className="side-nav">
                <button type="button" className="btn" onClick={c.reset}>
                  {c.loaded && c.loaded.list.choices.length > 1 ? 'Choose another entry' : 'Back'}
                </button>
                <button type="button" className="btn" onClick={c.startOver}>
                  New entry
                </button>
              </div>
            </aside>
          </div>
        ) : null}
      </main>
      {c.phase === 'results' && a?.candidateSet.ambiguous && !c.candidate ? (
        <div className="sr-only" role="status">
          <StateMark state="AMBIGUOUS" /> Choose a matching publication to see suggestions.
        </div>
      ) : null}
    </div>
  );
}
