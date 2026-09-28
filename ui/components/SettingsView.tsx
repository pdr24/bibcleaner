import { useEffect, useState } from 'react';
import type { Settings } from '../settings';
import { sanitizeSettings } from '../settings';
import { clearCache } from '../../core/net/cache';
import { generateKey } from '../../core/formatter/citekey';
import { hasAllSitesPermission, removeAllSitesPermission, requestUrlPermission } from '../platform';

const PART_LABEL = { author: 'First author', year: 'Year', keyword: 'Title keyword', venue: 'Venue' } as const;
type Part = keyof typeof PART_LABEL;
const SAMPLE = {
  title: 'Detecting Malware with Graph Neural Networks',
  authors: [{ family: 'Smith', given: 'John' }],
  year: 2025,
  venue: 'ACM Conference on Computer and Communications Security',
  venueShort: 'CCS',
  sourceRecords: [],
};

export function SettingsView({ settings, onSave, onClose }: { settings: Settings; onSave: (s: Settings) => void; onClose: () => void }) {
  const [s, setS] = useState(settings);
  const [cacheMsg, setCacheMsg] = useState<string | null>(null);
  const [allSites, setAllSites] = useState(false);
  useEffect(() => void hasAllSitesPermission().then(setAllSites), []);
  const up = (patch: Partial<Settings>) => setS(sanitizeSettings({ ...s, ...patch }));
  const togglePart = (p: Part) => {
    const has = s.keyScheme.parts.includes(p);
    const parts = has ? s.keyScheme.parts.filter((x) => x !== p) : [...s.keyScheme.parts, p];
    if (parts.length) up({ keyScheme: { ...s.keyScheme, parts } });
  };
  const move = (i: number, d: -1 | 1) => {
    const parts = [...s.keyScheme.parts];
    const j = i + d;
    if (j < 0 || j >= parts.length) return;
    [parts[i], parts[j]] = [parts[j], parts[i]];
    up({ keyScheme: { ...s.keyScheme, parts } });
  };
  return (
    <section className="settings" aria-labelledby="set-h">
      <h2 id="set-h">Settings</h2>

      <fieldset>
        <legend>Author names</legend>
        <label className="radio">
          <input type="radio" name="af" checked={s.authorFormat === 'last-first'} onChange={() => up({ authorFormat: 'last-first' })} />{' '}
          Smith, John and Doe, Jane
        </label>
        <label className="radio">
          <input type="radio" name="af" checked={s.authorFormat === 'first-last'} onChange={() => up({ authorFormat: 'first-last' })} />{' '}
          John Smith and Jane Doe
        </label>
        <label className="check-row">
          <input type="checkbox" checked={s.latexAccents} onChange={(e) => up({ latexAccents: e.target.checked })} /> Write accented letters
          as LaTeX commands, for example {'{\\"u}'} instead of ü
        </label>
      </fieldset>

      <fieldset>
        <legend>Citation keys</legend>
        <ul className="keyparts">
          {s.keyScheme.parts.map((p, i) => (
            <li key={p}>
              <span>{PART_LABEL[p as Part]}</span>
              <button
                type="button"
                className="linkish"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                aria-label={`Move ${PART_LABEL[p as Part]} earlier`}
              >
                Earlier
              </button>
              <button
                type="button"
                className="linkish"
                onClick={() => move(i, 1)}
                disabled={i === s.keyScheme.parts.length - 1}
                aria-label={`Move ${PART_LABEL[p as Part]} later`}
              >
                Later
              </button>
              <button type="button" className="linkish" onClick={() => togglePart(p as Part)} disabled={s.keyScheme.parts.length === 1}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        {(Object.keys(PART_LABEL) as Part[])
          .filter((p) => !s.keyScheme.parts.includes(p))
          .map((p) => (
            <button key={p} type="button" className="btn btn-small" onClick={() => togglePart(p)}>
              Add {PART_LABEL[p].toLowerCase()}
            </button>
          ))}
        <label className="inline">
          Separator{' '}
          <select value={s.keyScheme.separator} onChange={(e) => up({ keyScheme: { ...s.keyScheme, separator: e.target.value } })}>
            <option value="_">underscore _</option>
            <option value="-">hyphen -</option>
            <option value=":">colon :</option>
            <option value="">none</option>
          </select>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={s.keyScheme.lowercase}
            onChange={(e) => up({ keyScheme: { ...s.keyScheme, lowercase: e.target.checked } })}
          />{' '}
          Lowercase
        </label>
        <p className="muted small">
          Example: <code className="bib">{generateKey(SAMPLE, s.keyScheme) ?? '—'}</code>
        </p>
      </fieldset>

      <fieldset>
        <legend>Scholarly services</legend>
        <label className="stack">
          Contact e-mail (optional)
          <input
            type="email"
            value={s.contactEmail}
            placeholder="you@university.edu"
            onChange={(e) => setS({ ...s, contactEmail: e.target.value })}
          />
          <span className="muted small">
            Sent only to Crossref and OpenAlex, which give identified clients more reliable service. Leave empty to stay anonymous.
          </span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={allSites}
            onChange={async (e) => {
              if (e.target.checked) setAllSites(await requestUrlPermission('https://example.org', true));
              else {
                await removeAllSitesPermission();
                setAllSites(false);
              }
            }}
          />{' '}
          Allow URL checks on any site without asking each time
        </label>
        <p className="muted small">
          Otherwise BibCleaner asks for permission for one site when you press Check URL. Checks only read the page's title and DOI.
        </p>
      </fieldset>

      <fieldset>
        <legend>Local cache</legend>
        <label className="check-row">
          <input type="checkbox" checked={s.cacheEnabled} onChange={(e) => up({ cacheEnabled: e.target.checked })} /> Keep public metadata
          records on this device to avoid repeat lookups
        </label>
        <label className="inline">
          Keep found records for{' '}
          <input
            type="number"
            min={0}
            max={365}
            value={s.successTtlDays}
            onChange={(e) => up({ successTtlDays: Number(e.target.value) })}
          />{' '}
          days
        </label>
        <label className="inline">
          Remember “no record found” for{' '}
          <input
            type="number"
            min={0}
            max={720}
            value={s.notFoundTtlHours}
            onChange={(e) => up({ notFoundTtlHours: Number(e.target.value) })}
          />{' '}
          hours
        </label>
        <p className="muted small">Failed lookups are never cached. The cache holds public metadata only, not your citations.</p>
        <button
          type="button"
          className="btn btn-small"
          onClick={async () => {
            await clearCache();
            setCacheMsg('Cache cleared.');
          }}
        >
          Clear cache
        </button>
        {cacheMsg ? <span className="muted small"> {cacheMsg}</span> : null}
      </fieldset>

      <div className="settings-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            onSave(sanitizeSettings(s));
            onClose();
          }}
        >
          Save settings
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
      <p className="muted small">
        BibCleaner has no server and no analytics. Only the fields needed for a lookup (title, authors, year, DOI) are sent, and only to
        Crossref, DataCite, DBLP, OpenAlex, arXiv and doi.org.
      </p>
    </section>
  );
}
