import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Candidate, SourceStatus, Suggestion } from '../core/models/types';
import { analyze, type Analysis } from '../core/verification/pipeline';
import { evaluate, type Evaluation } from '../core/verification/evaluate';
import { checkUrl, type UrlCheckResult } from '../core/verification/url';
import { applySuggestions, type ApplyResult } from '../core/formatter/apply';
import { defaultSources } from '../sources';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './settings';
import { listEntries, type EntryList } from './entries';
import { acceptAll, carryDecisions, decide, rejectAll, setVersionChanges, type Decision } from './review/review';
import { requestUrlPermission } from './platform';

export type Phase = 'input' | 'pick' | 'running' | 'results';
export type Origin = 'paste' | 'selection' | 'file';

interface Loaded {
  origin: Origin;
  label: string;
  list: EntryList;
}

const sources = defaultSources();

export function useBibCleaner() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [phase, setPhase] = useState<Phase>('input');
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [entryIndex, setEntryIndex] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [statuses, setStatuses] = useState<SourceStatus[]>([]);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [urlCheck, setUrlCheck] = useState<UrlCheckResult | undefined>();
  const [urlChecking, setUrlChecking] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const run = useRef(0);

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  const updateSettings = useCallback(async (s: Settings) => {
    setSettings(s);
    await saveSettings(s);
  }, []);

  const startAnalysis = useCallback(
    async (entryText: string, list: EntryList | null, mode = settings.mode) => {
      const token = ++run.current;
      setPhase('running');
      setAnalysis(null);
      setStatuses([]);
      setSuggestions([]);
      setUrlCheck(undefined);
      setNotice(null);
      const a = await analyze(entryText, { mode, context: list && list.choices.length > 1 ? list.context : undefined }, sources, (st) => {
        if (run.current === token) setStatuses(st);
      });
      if (run.current !== token) return;
      setAnalysis(a);
      setStatuses(a.statuses);
      setCandidateId(a.candidateSet.selectedId);
      setPhase('results');
    },
    [settings.mode],
  );

  /** Entry point for pasted text, a context-menu selection, or a file. */
  const load = useCallback(
    (text: string, origin: Origin, label: string) => {
      const list = listEntries(text);
      setLoaded({ origin, label, list });
      setDraft(origin === 'file' ? '' : text);
      if (list.choices.length === 0) {
        // Text that contains an entry but does not parse goes through analysis
        // anyway: it makes no network call and gives the user the parse error,
        // the line it happened on and the structural checks.
        if (list.errorCount > 0 && /@\s*[A-Za-z]/.test(text)) {
          void startAnalysis(text, null);
          return;
        }
        setPhase('input');
        setNotice(text.trim() ? 'No BibTeX entry found. An entry starts with @ followed by a type, for example @article{key, ...}.' : null);
        return;
      }
      if (list.choices.length === 1) {
        setEntryIndex(0);
        // A single entry is analyzed from the exact text supplied, so Original is byte-for-byte what you gave.
        void startAnalysis(origin === 'file' ? list.choices[0].text : text, list);
        return;
      }
      setEntryIndex(null);
      setPhase('pick');
    },
    [startAnalysis],
  );

  const pickEntry = useCallback(
    (i: number) => {
      if (!loaded) return;
      setEntryIndex(i);
      void startAnalysis(loaded.list.choices[i].text, loaded.list);
    },
    [loaded, startAnalysis],
  );

  const reset = useCallback(() => {
    run.current++;
    setAnalysis(null);
    setSuggestions([]);
    setStatuses([]);
    setUrlCheck(undefined);
    setNotice(null);
    setPhase(loaded && loaded.list.choices.length > 1 ? 'pick' : 'input');
  }, [loaded]);

  const startOver = useCallback(() => {
    run.current++;
    setLoaded(null);
    setDraft('');
    setAnalysis(null);
    setSuggestions([]);
    setNotice(null);
    setPhase('input');
  }, []);

  const setMode = useCallback(
    async (mode: Settings['mode']) => {
      await updateSettings({ ...settings, mode });
      // Re-run so discovery matches the mode (lookups are cached).
      if (analysis) void startAnalysis(analysis.entryText, loaded?.list ?? null, mode);
    },
    [analysis, loaded, settings, startAnalysis, updateSettings],
  );

  const candidate: Candidate | null = useMemo(
    () => analysis?.candidateSet.candidates.find((c) => c.id === candidateId) ?? null,
    [analysis, candidateId],
  );

  const evaluation: Evaluation | null = useMemo(() => {
    if (!analysis?.input) return null;
    const existingKeys = loaded && loaded.list.choices.length > 1 ? loaded.list.keys : undefined;
    return evaluate(
      analysis.input,
      candidate,
      {
        mode: settings.mode,
        authorFormat: settings.authorFormat,
        keyScheme: settings.keyScheme,
        latexAccents: settings.latexAccents,
        existingKeys,
      },
      urlCheck,
      analysis.doiChecks,
    );
  }, [analysis, candidate, settings, urlCheck, loaded]);

  useEffect(() => {
    setSuggestions((prev) => carryDecisions(prev, evaluation?.suggestions ?? []));
  }, [evaluation]);

  const result: ApplyResult | null = useMemo(
    () => (analysis ? applySuggestions(analysis.entryText, suggestions) : null),
    [analysis, suggestions],
  );

  const runUrlCheck = useCallback(async () => {
    const url = analysis?.input?.fields.get('url');
    if (!url || !analysis?.input) return;
    // A URL check that finishes after the user moved to another citation must
    // not land on it.
    const token = run.current;
    const stale = () => run.current !== token;
    let allowed = false;
    try {
      allowed = await requestUrlPermission(url);
    } catch {
      allowed = false;
    }
    if (stale()) return;
    if (!allowed) {
      setUrlCheck({
        state: 'NOT CHECKED',
        label: 'URL not checked',
        detail: 'Permission to contact this site was not granted.',
        evidence: [],
      });
      return;
    }
    setUrlChecking(true);
    const w = candidate?.work;
    const r = await checkUrl(url, { title: analysis.input.work.title ?? w?.title, doi: analysis.input.work.doi ?? w?.doi });
    if (stale()) return;
    setUrlChecking(false);
    setUrlCheck(r);
  }, [analysis, candidate]);

  return {
    settings,
    updateSettings,
    setMode,
    phase,
    draft,
    setDraft,
    loaded,
    notice,
    entryIndex,
    load,
    pickEntry,
    reset,
    startOver,
    analysis,
    statuses,
    candidate,
    candidateId,
    setCandidateId,
    evaluation,
    suggestions,
    decideOne: (id: string, v: Decision) => setSuggestions((s) => decide(s, id, v)),
    acceptAll: () => setSuggestions((s) => acceptAll(s)),
    rejectAll: () => setSuggestions((s) => rejectAll(s)),
    setVersion: (v: Decision) => setSuggestions((s) => setVersionChanges(s, v)),
    result,
    urlCheck,
    urlChecking,
    runUrlCheck,
  };
}

export type Controller = ReturnType<typeof useBibCleaner>;
