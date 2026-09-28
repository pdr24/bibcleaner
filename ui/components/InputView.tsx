import { useRef, useState } from 'react';
import { isPopup, openInTab } from '../platform';

const MAX_FILE_BYTES = 5_000_000;

export function InputView({
  draft,
  setDraft,
  notice,
  onAnalyze,
  onFile,
  analyzeLabel,
}: {
  draft: string;
  setDraft: (s: string) => void;
  notice: string | null;
  onAnalyze: () => void;
  onFile: (text: string, name: string) => void;
  analyzeLabel: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const popup = isPopup();
  const wantsFile = new URLSearchParams(location.search).get('open') === 'file';
  const readFile = (f: File | undefined) => {
    setFileError(null);
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) return setFileError(`${f.name} is larger than 5 MB. Split it or paste the entry you want instead.`);
    // Read locally; the file never leaves this device.
    const r = new FileReader();
    r.onload = () => onFile(String(r.result ?? ''), f.name);
    r.onerror = () => setFileError(`Could not read ${f.name}.`);
    r.readAsText(f);
  };
  return (
    <section className="input">
      <label htmlFor="bib-in" className="input-label">
        Paste one BibTeX entry
      </label>
      <textarea
        id="bib-in"
        className="bib-in"
        spellCheck={false}
        autoFocus={!wantsFile}
        value={draft}
        placeholder={
          '@inproceedings{smith2025ai,\n  title  = {Using AI for IoT Security},\n  author = {Smith, John and Doe, Jane},\n  year   = {2025}\n}'
        }
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim()) onAnalyze();
        }}
      />
      {notice ? (
        <p className="notice" role="alert">
          {notice}
        </p>
      ) : null}
      <div className="input-actions">
        <button type="button" className="btn btn-primary" disabled={!draft.trim()} onClick={onAnalyze}>
          {analyzeLabel}
        </button>
        {popup ? (
          // The file dialog closes the popup on some systems, so files are opened in a tab.
          <button type="button" className="btn" onClick={() => openInTab('&open=file')}>
            Open a .bib file
          </button>
        ) : (
          <>
            <button type="button" className="btn" autoFocus={wantsFile} onClick={() => fileRef.current?.click()}>
              Open a .bib file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".bib,.bibtex,.txt,text/plain,application/x-bibtex"
              hidden
              onChange={(e) => readFile(e.target.files?.[0])}
            />
          </>
        )}
      </div>
      {fileError ? (
        <p className="notice" role="alert">
          {fileError}
        </p>
      ) : null}
      <p className="muted small hint">
        You can also select BibTeX on any web page, right-click, and choose <em>Clean or verify BibTeX</em>. Files are read on this device
        and never uploaded.
      </p>
    </section>
  );
}
