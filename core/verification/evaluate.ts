import type {
  Candidate,
  CheckResult,
  Confidence,
  Evidence,
  FieldComparison,
  SourceName,
  Suggestion,
  SuggestionCategory,
  VerificationState,
  Work,
} from '../models/types';
import type { InputCitation } from './input';
import { normalizeType, venueFieldFor } from './input';
import { getField } from '../parser/bibtex';
import { latexToUnicode, unicodeToLatex } from '../normalize/latex';
import { normalizeForComparison, titleSimilarity, tokenSimilarity, tokens } from '../normalize/text';
import { compareAuthorLists, formatAuthorList, parseAuthorField, type AuthorFormat } from '../normalize/authors';
import { venueSimilarity } from '../normalize/venue';
import { doiUrl, parseDoi, sameDoi } from '../normalize/doi';
import { normalizePages, pagesEquivalent } from '../normalize/pages';
import { detectProtectionTerms, wrapTerm } from '../formatter/capitalization';
import { generateKey, type KeyScheme, DEFAULT_KEY_SCHEME } from '../formatter/citekey';
import { applySuggestions, simpleInner } from '../formatter/apply';
import type { UrlCheckResult } from './url';

export type Mode = 'verify' | 'clean';

export interface EvalSettings {
  mode: Mode;
  authorFormat: AuthorFormat;
  keyScheme: KeyScheme;
  /** Convert accented letters from external metadata to LaTeX commands. */
  latexAccents: boolean;
  /** Keys already used elsewhere in a loaded .bib file (for collision suffixes). */
  existingKeys?: Set<string>;
}

export const DEFAULT_EVAL_SETTINGS: EvalSettings = {
  mode: 'clean',
  authorFormat: 'last-first',
  keyScheme: DEFAULT_KEY_SCHEME,
  latexAccents: true,
};

export interface Evaluation {
  comparisons: FieldComparison[];
  suggestions: Suggestion[];
  checks: CheckResult[];
}

const enc = (s: string, st: EvalSettings) => unicodeToLatex(s, { accents: st.latexAccents });

function lowerConfidence(c: Confidence): Confidence {
  return c === 'VERY HIGH' ? 'HIGH' : c === 'HIGH' ? 'POSSIBLE' : c;
}

const srcName = (w: Work): SourceName => w.sourceRecords[0]?.source ?? 'URL';

export function evaluate(
  input: InputCitation,
  cand: Candidate | null,
  settings: EvalSettings,
  urlCheck?: UrlCheckResult,
  doiChecks: CheckResult[] = [],
): Evaluation {
  const comparisons: FieldComparison[] = [];
  const suggestions: Suggestion[] = [];
  const checks: CheckResult[] = [...doiChecks];
  let n = 0;
  const id = (f: string) => `${f}-${n++}`;
  const e = input.entry;
  const has = (f: string) => !!getField(e, f);
  const cur = (f: string) => input.fields.get(f);
  const clean = settings.mode === 'clean';
  const baseConf: Confidence = cand ? cand.score.confidence : 'LOW';
  const versionMode = !!cand && input.citesPreprint && !cand.work.isPreprint;
  // A candidate with critical contradictions may be shown and compared, but its
  // values are never used to enrich the citation's identifiers or its key.
  const trusted = !!cand && cand.score.criticalContradictions.length === 0;
  const cat = (c: SuggestionCategory): SuggestionCategory => (versionMode && (c === 'conflict' || c === 'missing') ? 'version' : c);
  const versionNote = versionMode ? ' Your citation points to a preprint; this value comes from the published version.' : '';

  const push = (s: Omit<Suggestion, 'id' | 'accepted'>) => {
    // Verify mode proposes corrections to wrong metadata only.
    if (!clean && s.category !== 'conflict' && s.category !== 'version' && s.category !== 'url') return;
    suggestions.push({ ...s, id: id(s.field), accepted: null });
  };

  /** Per-source evidence for one field of the candidate. */
  const evidence = (get: (w: Work) => string | undefined, agrees: (v: string) => boolean): Evidence[] => {
    const out: Evidence[] = [];
    if (!cand) return out;
    for (const r of cand.records) {
      const v = get(r);
      if (v === undefined || v === '') continue;
      out.push({ source: srcName(r), value: v, recordUrl: r.sourceRecords[0]?.recordUrl, agrees: agrees(v) });
    }
    return out;
  };
  const sourcesDisagree = (ev: Evidence[], eq: (a: string, b: string) => boolean) =>
    ev.some((x) => ev.some((y) => x !== y && x.value && y.value && !eq(x.value, y.value)));
  const sourceList = (ev: Evidence[]) => [...new Set(ev.map((x) => x.source))].join(' and ');
  const current = (v?: string): Evidence[] => (v ? [{ source: 'Current BibTeX', value: v }] : []);

  if (!cand) {
    checks.push({
      id: 'match',
      label: 'No matching publication selected',
      state: 'UNVERIFIED',
      detail: 'Field values could not be checked against a scholarly record.',
    });
  } else {
    checks.push({
      id: 'match',
      label: `${cand.score.state === 'VERIFIED' ? 'Verified' : cand.score.state === 'CONFLICT' ? 'Conflicting' : cand.score.confidence.toLowerCase().replace(/^./, (c) => c.toUpperCase())} match: ${cand.work.title ?? cand.work.doi}`,
      state: cand.score.state,
      detail: cand.score.criticalContradictions.join(' ') || undefined,
    });
  }
  const w = cand?.work;

  // ---------------- Entry type ----------------
  if (w?.type && w.type !== 'preprint' && w.type !== 'misc') {
    const inType = normalizeType(e.type);
    const same = inType === w.type || (w.type === 'phdthesis' && inType === 'mastersthesis');
    comparisons.push({
      field: 'entry type',
      input: `@${e.type}`,
      authoritative: `@${w.type}`,
      status: same ? 'VERIFIED' : 'CONFLICT',
      evidence: evidence(
        (r) => (r.type && r.type !== 'misc' ? r.type : undefined),
        (v) => v === inType,
      ),
    });
    if (!same) {
      push({
        field: 'ENTRYTYPE',
        operation: 'replace',
        category: cat('conflict'),
        patch: { kind: 'set', value: w.type },
        title: 'Change entry type',
        originalValue: `@${e.type}`,
        suggestedValue: `@${w.type}`,
        confidence: baseConf,
        reason: `The matched record is a ${w.type === 'inproceedings' ? 'conference paper' : w.type === 'article' ? 'journal article' : w.type}.${versionNote}`,
        sources: evidence(
          (r) => r.type,
          () => true,
        ),
      });
      const fromField = venueFieldFor(e.type);
      const toField = venueFieldFor(w.type);
      if (
        !versionMode &&
        fromField !== toField &&
        has(fromField) &&
        !has(toField) &&
        (fromField === 'journal' || fromField === 'booktitle') &&
        (toField === 'journal' || toField === 'booktitle')
      ) {
        push({
          field: fromField,
          operation: 'rename',
          category: cat('conflict'),
          patch: { kind: 'rename', to: toField },
          title: `Rename ${fromField} to ${toField}`,
          originalValue: fromField,
          suggestedValue: toField,
          confidence: baseConf,
          reason: `@${w.type} entries put the venue in ${toField}. Only useful if you also accept the entry type change.`,
          sources: [],
        });
      }
    }
  }

  // ---------------- Title ----------------
  const inTitle = cur('title');
  if (w?.title) {
    const sim = inTitle ? titleSimilarity(inTitle, w.title) : 0;
    const ev = evidence(
      (r) => r.title,
      (v) => !!inTitle && normalizeForComparison(v) === normalizeForComparison(inTitle),
    );
    let status: VerificationState = !inTitle
      ? 'MISSING'
      : normalizeForComparison(inTitle) === normalizeForComparison(w.title)
        ? 'VERIFIED'
        : sim >= 0.9
          ? 'HIGH CONFIDENCE'
          : 'CONFLICT';
    if (status === 'VERIFIED' && sourcesDisagree(ev, (a, b) => normalizeForComparison(a) === normalizeForComparison(b)))
      status = 'HIGH CONFIDENCE';
    comparisons.push({
      field: 'title',
      input: inTitle && latexToUnicode(inTitle),
      authoritative: w.title,
      status,
      note: status === 'HIGH CONFIDENCE' ? 'Minor wording or punctuation differences.' : undefined,
      evidence: [...current(inTitle && latexToUnicode(inTitle)), ...ev],
    });
    if (status !== 'VERIFIED' && !input.inherited.has('title')) {
      push({
        field: 'title',
        operation: inTitle ? 'replace' : 'add',
        category: cat(inTitle ? 'conflict' : 'missing'),
        patch: { kind: 'set', value: enc(w.title, settings) },
        group: 'title',
        title: inTitle ? 'Use the title from the publication record' : 'Add title',
        originalValue: inTitle,
        suggestedValue: enc(w.title, settings),
        confidence: status === 'HIGH CONFIDENCE' ? baseConf : lowerConfidence(baseConf),
        reason: `${sourceList(ev)} record${ev.length > 1 ? 's give' : ' gives'} this title${inTitle ? ` (similarity ${(sim * 100).toFixed(0)}%)` : ''}. Existing braces for capitalization are not carried over; review capitalization suggestions after accepting.${versionNote}`,
        sources: [...current(inTitle), ...ev],
      });
    }
    // Same title, but the entry lost capitalization the record carries (e.g. "ai" vs "AI").
    const plainIn = inTitle ? latexToUnicode(inTitle).replace(/[{}]/g, '') : undefined;
    if (clean && status === 'VERIFIED' && plainIn && plainIn !== w.title && !input.inherited.has('title')) {
      const lost = detectProtectionTerms(w.title).filter(
        (t) => !new RegExp(`(^|[^\\p{L}\\p{N}])${t.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(plainIn),
      );
      if (lost.length) {
        let v = enc(w.title, settings);
        for (const t of lost) v = wrapTerm(v, t.term);
        push({
          field: 'title',
          operation: 'format',
          category: 'format',
          patch: { kind: 'set', value: v },
          group: 'title',
          title: 'Restore capitalization from the publication record',
          originalValue: inTitle,
          suggestedValue: v,
          confidence: 'HIGH',
          reason: `Your title matches the record except for letter case, and it has lost the capitalization of ${lost.map((t) => t.term).join(', ')}. The record's title is used, with those terms protected by braces.`,
          sources: [...current(inTitle), ...ev],
        });
      }
    }
  } else if (inTitle) comparisons.push({ field: 'title', input: latexToUnicode(inTitle), status: 'NOT CHECKED', evidence: [] });

  // Capitalization protection — computed on the current title.
  const titleField = getField(e, 'title');
  if (clean && titleField && inTitle) {
    const inner = simpleInner(titleField);
    if (inner !== undefined) {
      for (const t of detectProtectionTerms(inner)) {
        push({
          field: 'title',
          operation: 'format',
          category: 'format',
          patch: { kind: 'wrap', term: t.term },
          title: `Protect capitalization of ${t.term}`,
          originalValue: t.term,
          suggestedValue: `{${t.term}}`,
          confidence: t.kind === 'proper-name' ? 'POSSIBLE' : 'HIGH',
          reason: `Many bibliography styles lowercase titles; braces keep "${t.term}" as written.${t.kind === 'proper-name' ? ' Detected as a likely proper name.' : ''}`,
          sources: [],
        });
      }
    }
  }

  // ---------------- Authors ----------------
  const inAuthorRaw = cur('author');
  const inAuthors = parseAuthorField(inAuthorRaw);
  if (w && w.authors.length) {
    const cmp = compareAuthorLists(inAuthors.authors, w.authors, inAuthors.truncated);
    const authStr = (r: Work) => r.authors.map((a) => [a.given, a.family].filter(Boolean).join(' ')).join('; ');
    const ev = evidence(
      (r) => (r.authors.length ? authStr(r) : undefined),
      () => true,
    );
    for (const x of ev) {
      const rec = cand!.records.find((r) => srcName(r) === x.source && authStr(r) === x.value);
      x.agrees = rec ? compareAuthorLists(inAuthors.authors, rec.authors, inAuthors.truncated).score >= 0.9 : undefined;
    }
    let status: VerificationState;
    if (!inAuthors.authors.length) status = 'MISSING';
    else if (cmp.score >= 0.95 && (cmp.countA === cmp.countB || inAuthors.truncated)) status = 'VERIFIED';
    else if (cmp.score >= 0.85) status = 'HIGH CONFIDENCE';
    else status = 'CONFLICT';
    const display =
      inAuthors.authors.map((a) => latexToUnicode([a.given, a.family].filter(Boolean).join(' '))).join('; ') +
      (inAuthors.truncated ? '; others' : '');
    comparisons.push({
      field: 'author',
      input: display || undefined,
      authoritative: authStr(w),
      status,
      note: inAuthors.truncated ? 'Your list ends with "and others".' : undefined,
      evidence: ev,
    });

    // Only propose author text from sources that give structured names (Crossref/DataCite)
    // or when the lists genuinely differ; OpenAlex/DBLP display names are split heuristically.
    const structured = cand!.records.find((r) => (srcName(r) === 'Crossref' || srcName(r) === 'DataCite') && r.authors.length);
    const best = structured ?? cand!.records.find((r) => r.authors.length)!;
    const proposed = formatAuthorList(best.authors, settings.authorFormat, true);
    if (!input.inherited.has('author')) {
      if (status === 'CONFLICT' || status === 'MISSING') {
        push({
          field: 'author',
          operation: inAuthorRaw ? 'replace' : 'add',
          category: cat(inAuthorRaw ? 'conflict' : 'missing'),
          patch: { kind: 'set', value: proposed },
          group: 'author',
          title: inAuthorRaw ? 'Replace author list' : 'Add authors',
          originalValue: inAuthorRaw,
          suggestedValue: proposed,
          confidence: lowerConfidence(baseConf),
          reason: inAuthorRaw
            ? `The author list differs from ${srcName(best)} (${cmp.countA} vs ${cmp.countB} authors, ${(cmp.overlap * 100).toFixed(0)}% overlap).${versionNote}`
            : `Authors from ${srcName(best)}.`,
          sources: [...current(inAuthorRaw), ...ev],
        });
      } else if (clean && inAuthors.truncated && w.authors.length > inAuthors.authors.length) {
        push({
          field: 'author',
          operation: 'replace',
          category: 'missing',
          patch: { kind: 'set', value: proposed },
          group: 'author',
          title: 'Complete the author list',
          originalValue: inAuthorRaw,
          suggestedValue: proposed,
          confidence: baseConf,
          reason: `Your entry ends with "and others"; ${srcName(best)} lists all ${w.authors.length} authors.`,
          sources: ev,
        });
      } else if (clean && cmp.otherHasFullerNames && structured) {
        push({
          field: 'author',
          operation: 'replace',
          category: 'missing',
          patch: { kind: 'set', value: proposed },
          group: 'author',
          title: 'Use full author names',
          originalValue: inAuthorRaw,
          suggestedValue: proposed,
          confidence: baseConf,
          reason: `${srcName(best)} gives fuller given names for the same authors.`,
          sources: ev,
        });
      }
    }
  } else if (inAuthorRaw) comparisons.push({ field: 'author', input: latexToUnicode(inAuthorRaw), status: 'NOT CHECKED', evidence: [] });

  // Consistent author name format (formatting only; same names).
  if (clean && inAuthorRaw && inAuthors.authors.length > 1 && !input.inherited.has('author')) {
    const commaStyle = inAuthorRaw.split(/\s+and\s+/i).map((x) => x.includes(','));
    const mixed = commaStyle.some(Boolean) && commaStyle.some((x) => !x);
    if (mixed) {
      const v = formatAuthorList(inAuthors.authors, settings.authorFormat, false, inAuthors.truncated);
      push({
        field: 'author',
        operation: 'format',
        category: 'format',
        patch: { kind: 'set', value: v },
        group: 'author',
        title: 'Use one author name format',
        originalValue: inAuthorRaw,
        suggestedValue: v,
        confidence: 'HIGH',
        reason: `Your entry mixes "Last, First" and "First Last". The names are unchanged; only the order of name parts is made consistent.`,
        sources: [],
      });
    }
  }

  // ---------------- Year ----------------
  const inYear = cur('year');
  if (w?.year) {
    const ev = evidence(
      (r) => (r.year ? String(r.year) : undefined),
      (v) => v === inYear?.trim(),
    );
    const disagree = sourcesDisagree(ev, (a, b) => a === b);
    const status: VerificationState = !inYear
      ? 'MISSING'
      : inYear.trim() === String(w.year)
        ? disagree
          ? 'HIGH CONFIDENCE'
          : 'VERIFIED'
        : 'CONFLICT';
    comparisons.push({
      field: 'year',
      input: inYear,
      authoritative: String(w.year),
      status,
      note: disagree ? 'Sources disagree on the year.' : undefined,
      evidence: [...current(inYear), ...ev],
    });
    if ((status === 'CONFLICT' || status === 'MISSING') && !input.inherited.has('year')) {
      const agreeing = ev.filter((x) => x.value === String(w.year)).map((x) => x.source);
      push({
        field: 'year',
        operation: inYear ? 'replace' : 'add',
        category: cat(inYear ? 'conflict' : 'missing'),
        patch: { kind: 'set', value: String(w.year) },
        title: inYear ? 'Change year' : 'Add year',
        originalValue: inYear,
        suggestedValue: String(w.year),
        confidence: disagree ? 'POSSIBLE' : baseConf,
        reason: `${agreeing.join(' and ')} ${agreeing.length > 1 ? 'both report' : 'reports'} publication year ${w.year}.${disagree ? ' Other sources disagree — check the evidence.' : ''}${versionNote}`,
        sources: [...current(inYear), ...ev],
      });
    }
  } else if (inYear) comparisons.push({ field: 'year', input: inYear, status: 'NOT CHECKED', evidence: [] });

  // ---------------- Venue ----------------
  const targetType = w?.type && w.type !== 'preprint' && w.type !== 'misc' ? w.type : normalizeType(e.type);
  const vField = venueFieldFor(targetType);
  const inVenueField = ['journal', 'booktitle', 'journaltitle', 'howpublished'].find((f) => input.fields.has(f));
  const inVenue = inVenueField ? cur(inVenueField) : undefined;
  if (w?.venue && (vField === 'journal' || vField === 'booktitle' || inVenue)) {
    const sim = inVenue ? venueSimilarity(latexToUnicode(inVenue), w.venue, undefined, w.venueShort) : 0;
    const ev = evidence(
      (r) => r.venue,
      (v) => !!inVenue && venueSimilarity(latexToUnicode(inVenue), v) >= 0.85,
    );
    const status: VerificationState = !inVenue ? 'MISSING' : sim >= 0.85 ? 'VERIFIED' : sim >= 0.6 ? 'HIGH CONFIDENCE' : 'CONFLICT';
    comparisons.push({
      field: inVenueField ?? vField,
      input: inVenue && latexToUnicode(inVenue),
      authoritative: w.venue,
      status,
      note: status === 'HIGH CONFIDENCE' ? 'Venue names are compatible (e.g. abbreviated).' : undefined,
      evidence: [...current(inVenue), ...ev],
    });
    const fullVenue = cand!.records.find((r) => r.venue && r.venue !== r.venueShort)?.venue ?? w.venue;
    if (status === 'MISSING' && (vField === 'journal' || vField === 'booktitle') && !input.inherited.has(vField)) {
      push({
        field: vField,
        operation: 'add',
        category: cat('missing'),
        patch: { kind: 'set', value: enc(fullVenue, settings) },
        title: `Add ${vField}`,
        suggestedValue: enc(fullVenue, settings),
        confidence: baseConf,
        reason: `The venue is missing; ${sourceList(ev)} give${ev.length > 1 ? '' : 's'} "${fullVenue}".${versionNote}`,
        sources: ev,
      });
    } else if (status === 'CONFLICT' && inVenueField && !input.inherited.has(inVenueField)) {
      const targetField = versionMode && (vField === 'journal' || vField === 'booktitle') ? vField : inVenueField;
      const sameField = targetField === inVenueField;
      push({
        field: targetField,
        operation: sameField ? 'replace' : 'add',
        category: cat('conflict'),
        patch: { kind: 'set', value: enc(fullVenue, settings) },
        title: sameField ? `Change ${targetField}` : `Add ${targetField}`,
        originalValue: sameField ? inVenue : undefined,
        suggestedValue: enc(fullVenue, settings),
        confidence: lowerConfidence(baseConf),
        reason: `Your venue does not match the publication record.${versionNote}`,
        sources: [...current(inVenue), ...ev],
      });
      if (versionMode && !sameField) {
        push({
          field: inVenueField,
          operation: 'remove',
          category: 'version',
          patch: { kind: 'remove' },
          title: `Remove ${inVenueField} (preprint venue)`,
          originalValue: inVenue,
          suggestedValue: '(removed)',
          confidence: 'POSSIBLE',
          reason: `After converting to the published version, "${latexToUnicode(inVenue!)}" would describe the preprint, not the paper you cite.`,
          warning: 'Only remove this if you are converting the citation to the published version.',
          sources: [],
        });
      }
    }
  } else if (inVenue) comparisons.push({ field: inVenueField!, input: latexToUnicode(inVenue), status: 'NOT CHECKED', evidence: [] });

  // ---------------- Simple fields ----------------
  const simpleField = (
    field: string,
    get: (r: Work) => string | undefined,
    eq: (a: string, b: string) => boolean,
    want: boolean,
    display: (v: string) => string = (v) => v,
  ) => {
    const inV = cur(field);
    const auth = w ? get(w) : undefined;
    if (!auth) {
      if (inV) comparisons.push({ field, input: inV, status: 'NOT CHECKED', evidence: [] });
      return;
    }
    const ev = evidence(get, (v) => !!inV && eq(inV, v));
    const status: VerificationState = !inV ? 'MISSING' : eq(inV, auth) ? 'VERIFIED' : 'CONFLICT';
    comparisons.push({ field, input: inV, authoritative: display(auth), status, evidence: [...current(inV), ...ev] });
    if (input.inherited.has(field)) return;
    if (status === 'MISSING' && want) {
      push({
        field,
        operation: 'add',
        category: cat('missing'),
        patch: { kind: 'set', value: display(auth) },
        title: `Add ${field}`,
        suggestedValue: display(auth),
        confidence: baseConf,
        reason: `${sourceList(ev)} provide${ev.length > 1 ? '' : 's'} the ${field}.${versionNote}`,
        sources: ev,
      });
    } else if (status === 'CONFLICT') {
      push({
        field,
        operation: 'replace',
        category: cat('conflict'),
        patch: { kind: 'set', value: display(auth) },
        group: field,
        title: `Change ${field}`,
        originalValue: inV,
        suggestedValue: display(auth),
        confidence: lowerConfidence(baseConf),
        reason: `${sourceList(ev)} give${ev.length > 1 ? '' : 's'} a different ${field}.${versionNote}`,
        sources: [...current(inV), ...ev],
      });
    }
  };
  const t = targetType;
  const loose = (a: string, b: string) => normalizeForComparison(a) === normalizeForComparison(b);
  simpleField('volume', (r) => r.volume, loose, t === 'article' || t === 'incollection');
  simpleField('number', (r) => r.issue, loose, t === 'article');
  simpleField(
    'pages',
    (r) => r.pages,
    (a, b) => pagesEquivalent(a, b),
    true,
    (v) => normalizePages(v) ?? v,
  );
  simpleField(
    'publisher',
    (r) => r.publisher,
    (a, b) => tokenSimilarity(tokens(a), tokens(b)) >= 0.6,
    ['inproceedings', 'book', 'incollection', 'proceedings', 'techreport'].includes(t),
    (v) => enc(v, settings),
  );
  simpleField(
    'isbn',
    (r) => r.isbn?.[0],
    (a, b) =>
      a.replace(/[^0-9Xx]/g, '') === b.replace(/[^0-9Xx]/g, '') ||
      (w?.isbn ?? []).some((x) => x.replace(/[^0-9Xx]/g, '') === a.replace(/[^0-9Xx]/g, '')),
    ['book', 'incollection', 'inproceedings'].includes(t),
  );
  simpleField(
    'issn',
    (r) => r.issn?.[0],
    (a, b) =>
      a.replace(/[^0-9Xx]/g, '') === b.replace(/[^0-9Xx]/g, '') ||
      (w?.issn ?? []).some((x) => x.replace(/[^0-9Xx]/g, '') === a.replace(/[^0-9Xx]/g, '')),
    t === 'article',
  );

  // ---------------- DOI ----------------
  const parsedInDoi = parseDoi(input.rawDoi);
  if (w?.doi) {
    const ev = evidence(
      (r) => r.doi,
      (v) => sameDoi(v, input.rawDoi),
    );
    const status: VerificationState = !input.rawDoi ? 'MISSING' : sameDoi(input.rawDoi, w.doi) ? 'VERIFIED' : 'CONFLICT';
    comparisons.push({ field: 'doi', input: input.rawDoi, authoritative: w.doi, status, evidence: [...current(input.rawDoi), ...ev] });
    if (!input.inherited.has('doi')) {
      if (status === 'MISSING') {
        push({
          field: 'doi',
          operation: 'add',
          category: cat('missing'),
          patch: { kind: 'set', value: w.doi },
          group: 'doi',
          title: 'Add DOI',
          suggestedValue: w.doi,
          confidence: baseConf,
          reason: `${sourceList(ev)} list${ev.length > 1 ? '' : 's'} this DOI for the matched publication.${versionNote}`,
          sources: ev,
        });
      } else if (status === 'CONFLICT') {
        push({
          field: 'doi',
          operation: 'replace',
          category: cat('conflict'),
          patch: { kind: 'set', value: w.doi },
          group: 'doi',
          title: 'Change DOI',
          originalValue: input.rawDoi,
          suggestedValue: w.doi,
          confidence: lowerConfidence(baseConf),
          reason: `The DOI in your entry does not belong to the matched publication.${versionNote}`,
          sources: [...current(input.rawDoi), ...ev],
        });
      }
    }
  } else if (input.rawDoi) comparisons.push({ field: 'doi', input: input.rawDoi, status: 'NOT CHECKED', evidence: [] });
  if (clean && parsedInDoi && !parsedInDoi.wasCanonical && !input.inherited.has('doi')) {
    push({
      field: 'doi',
      operation: 'format',
      category: 'format',
      patch: { kind: 'set', value: parsedInDoi.doi },
      group: 'doi',
      title: 'Normalize DOI',
      originalValue: input.rawDoi,
      suggestedValue: parsedInDoi.doi,
      confidence: 'VERY HIGH',
      reason: 'The doi field should hold the bare DOI; styles add the https://doi.org/ prefix themselves.',
      sources: [],
    });
  }

  // ---------------- URL ----------------
  const inUrl = cur('url');
  // A DOI that is registered to another work must not become a link either:
  // building "https://doi.org/<wrong doi>" would point the reader at the wrong
  // paper through what looks like a formatting change.
  const doiSuspect =
    !!parsedInDoi &&
    (doiChecks.some((c) => c.id === 'doi-identity' && c.state === 'CONFLICT') || (trusted && !!w?.doi && !sameDoi(parsedInDoi.doi, w.doi)));
  const finalDoi = doiSuspect ? undefined : (parsedInDoi?.doi ?? (trusted ? w?.doi : undefined));
  if (inUrl) {
    const u = urlCheck;
    if (u) {
      comparisons.push({ field: 'url', input: inUrl, authoritative: u.finalUrl, status: u.state, note: u.detail, evidence: u.evidence });
      checks.push({ id: 'url', label: u.label, state: u.state, detail: u.detail });
      if ((u.state === 'UNREACHABLE' || u.state === 'CONFLICT') && finalDoi) {
        push({
          field: 'url',
          operation: 'replace',
          category: 'url',
          patch: { kind: 'set', value: doiUrl(finalDoi) },
          group: 'url',
          title: 'Replace URL with the DOI link',
          originalValue: inUrl,
          suggestedValue: doiUrl(finalDoi),
          confidence: 'HIGH',
          reason:
            u.state === 'UNREACHABLE'
              ? 'The URL no longer resolves, but the DOI does. The DOI link is the most stable URL.'
              : 'The URL points to a different work than this citation.',
          sources: [],
        });
      }
    } else {
      comparisons.push({ field: 'url', input: inUrl, status: 'NOT CHECKED', note: 'Use "Check URL" to verify it.', evidence: [] });
      checks.push({ id: 'url', label: 'URL not checked yet', state: 'NOT CHECKED' });
    }
  } else if (clean && finalDoi && !input.inherited.has('url')) {
    // In version mode the only DOI available is the published version's, so
    // adding its link is part of converting the citation, not formatting.
    const fromPublished = versionMode && !parsedInDoi;
    push({
      field: 'url',
      operation: 'add',
      category: fromPublished ? 'version' : 'format',
      patch: { kind: 'set', value: doiUrl(finalDoi) },
      group: 'url',
      title: 'Add URL from DOI',
      suggestedValue: doiUrl(finalDoi),
      confidence: parsedInDoi ? 'HIGH' : baseConf,
      reason: `Some styles print a URL but not a DOI. The DOI link is stable.${fromPublished ? versionNote : ''}`,
      sources: [],
    });
  }

  // ---------------- arXiv eprint (only when citing the preprint) ----------------
  if (clean && input.citesPreprint && !versionMode && w?.arxivId && !has('eprint')) {
    push({
      field: 'eprint',
      operation: 'add',
      category: 'missing',
      patch: { kind: 'set', value: w.arxivId },
      title: 'Add arXiv identifier',
      suggestedValue: w.arxivId,
      confidence: baseConf,
      reason: 'BibLaTeX and many styles link arXiv preprints through eprint + archivePrefix.',
      sources: evidence(
        (r) => r.arxivId,
        () => true,
      ),
    });
    if (!has('archiveprefix') && !has('eprinttype'))
      push({
        field: 'archivePrefix',
        operation: 'add',
        category: 'missing',
        patch: { kind: 'set', value: 'arXiv' },
        title: 'Add archivePrefix',
        suggestedValue: 'arXiv',
        confidence: baseConf,
        reason: 'Tells the style that eprint is an arXiv identifier.',
        sources: [],
      });
  }

  // ---------------- Pages format ----------------
  const pagesVal = cur('pages');
  if (
    clean &&
    pagesVal &&
    normalizePages(pagesVal) !== pagesVal &&
    !suggestions.some((s) => s.field === 'pages') &&
    !input.inherited.has('pages')
  ) {
    push({
      field: 'pages',
      operation: 'format',
      category: 'format',
      patch: { kind: 'set', value: normalizePages(pagesVal)! },
      title: 'Use an en dash in page ranges',
      originalValue: pagesVal,
      suggestedValue: normalizePages(pagesVal)!,
      confidence: 'VERY HIGH',
      reason: 'BibTeX page ranges use "--" (an en dash).',
      sources: [],
    });
  }

  // ---------------- Citation key ----------------
  if (clean) {
    // While the entry still cites the preprint, the key must describe the
    // preprint. It is regenerated from the published record once the version
    // change is accepted and the entry is analyzed again.
    const basis: Work =
      versionMode || !trusted ? { ...input.work, venue: input.work.venue ?? (trusted ? w?.venue : undefined) } : (w ?? input.work);
    const existing = new Set([...(settings.existingKeys ?? [])].filter((k) => k !== e.key));
    const key = generateKey(basis, settings.keyScheme, existing);
    if (key && key !== e.key) {
      push({
        field: 'KEY',
        operation: 'replace',
        category: 'key',
        patch: { kind: 'set', value: key },
        title: 'Rename citation key',
        originalValue: e.key,
        suggestedValue: key,
        confidence: 'HIGH',
        reason: `Follows your key scheme (author, year, title keyword, venue).${versionMode ? ' It describes the preprint you are citing; converting to the published version would change it again.' : ''}`,
        warning: 'Changing this key may break citations elsewhere in your LaTeX project.',
        sources: [],
      });
    }
  }

  // ---------------- Layout ----------------
  const tidy = applySuggestions(e.text, [
    {
      id: 'probe',
      field: 'ENTRY',
      operation: 'format',
      category: 'format',
      patch: { kind: 'layout' },
      title: '',
      suggestedValue: '',
      confidence: 'HIGH',
      reason: '',
      sources: [],
      accepted: true,
    },
  ]).text;
  if (clean && tidy !== e.text) {
    push({
      field: 'ENTRY',
      operation: 'format',
      category: 'format',
      patch: { kind: 'layout' },
      title: 'Tidy layout',
      suggestedValue: 'Aligned fields, braces instead of quotes, standard field order',
      confidence: 'VERY HIGH',
      reason: 'Reformats the entry for readability. Values, custom fields and macros are kept.',
      sources: [],
    });
  }

  return { comparisons, suggestions, checks };
}
