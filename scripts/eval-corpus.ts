/**
 * Acceptance-corpus evaluation against the LIVE scholarly APIs (PRD §51).
 *
 *   npm run eval -- path/to/corpus.json [--mode clean|verify] [--email you@uni.edu]
 *
 * The corpus is a JSON array of LiveEntry (see scripts/eval/metrics.ts and
 * docs/CALIBRATION.md). Every `truth` must be verified by hand.
 * Exits with status 1 if any high-confidence correction is wrong, so it can
 * gate a release. Responses are cached in .cache/eval-cache.json to keep
 * repeat runs polite to the services.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { analyze } from '../core/verification/pipeline';
import { evaluate, DEFAULT_EVAL_SETTINGS, type Mode } from '../core/verification/evaluate';
import { setKV } from '../core/net/cache';
import { sourceSettings } from '../sources/types';
import { defaultSources } from '../sources';
import { judge, report, top1Correct, type EntryOutcome, type LiveEntry } from './eval/metrics';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!file) {
  console.error('Usage: npm run eval -- <corpus.json> [--mode clean|verify] [--email you@uni.edu]');
  process.exit(2);
}
const mode: Mode = opt('mode') === 'verify' ? 'verify' : 'clean';
sourceSettings.contactEmail = opt('email') ?? process.env.BIBCLEANER_EMAIL;

// File-backed cache (public metadata only).
const CACHE = '.cache/eval-cache.json';
mkdirSync('.cache', { recursive: true });
const store: Record<string, unknown> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
let dirty = false;
setKV({
  get: async (k) => store[k],
  set: async (k, v) => {
    store[k] = v;
    dirty = true;
  },
  clear: async (p) => {
    for (const k of Object.keys(store)) if (k.startsWith(p)) delete store[k];
  },
});

const corpus = (JSON.parse(readFileSync(file, 'utf8')) as LiveEntry[]).filter((e) => !e._template);
const sources = defaultSources();
const outcomes: EntryOutcome[] = [];

for (const [i, entry] of corpus.entries()) {
  process.stderr.write(`[${i + 1}/${corpus.length}] ${entry.id}\n`);
  try {
    const a = await analyze(entry.bib, { mode }, sources);
    if (!a.input) throw new Error('did not parse');
    const cs = a.candidateSet;
    const sel = cs.candidates.find((c) => c.id === cs.selectedId) ?? null;
    const ev = evaluate(a.input, sel, { ...DEFAULT_EVAL_SETTINGS, mode }, undefined, a.doiChecks);
    outcomes.push({
      id: entry.id,
      inputHadDoi: a.input.rawDoi !== undefined,
      truth: entry.truth,
      ambiguousPredicted: cs.ambiguous,
      top1: top1Correct(sel, entry.truth),
      score: sel?.score.total,
      judged: ev.suggestions.map((s) => ({ s, verdict: judge(s, entry.truth) })),
    });
  } catch (e) {
    outcomes.push({
      id: entry.id,
      inputHadDoi: false,
      truth: entry.truth,
      ambiguousPredicted: false,
      judged: [],
      error: (e as Error).message,
    });
  }
  if (dirty) writeFileSync(CACHE, JSON.stringify(store));
}

const r = report(outcomes);
console.log(r.lines.join('\n'));
for (const o of outcomes.filter((x) => x.error)) console.log(`  error ${o.id}: ${o.error}`);
for (const o of outcomes)
  for (const j of o.judged.filter((x) => x.verdict === 'incorrect'))
    console.log(`  wrong: ${o.id} ${j.s.field} -> ${j.s.suggestedValue} (${j.s.confidence})`);
if (r.highConfidenceIncorrect.length) {
  console.error(
    '\nRELEASE BLOCKER: incorrect high-confidence corrections found. Tighten the rule or lower its confidence; do not lower thresholds.',
  );
  process.exit(1);
}
