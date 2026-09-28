import type { CheckResult } from '../models/types';
import type { BibEntry, ParseError, ValuePart } from '../parser/bibtex';
import { KNOWN_ENTRY_TYPES, valueToText } from '../parser/bibtex';
import { normalizeType } from './input';

const REQUIRED: Record<string, string[][]> = {
  article: [['author'], ['title'], ['journal', 'journaltitle'], ['year', 'date']],
  inproceedings: [['author'], ['title'], ['booktitle'], ['year', 'date']],
  incollection: [['author'], ['title'], ['booktitle'], ['publisher'], ['year', 'date']],
  book: [['author', 'editor'], ['title'], ['publisher'], ['year', 'date']],
  phdthesis: [['author'], ['title'], ['school', 'institution'], ['year', 'date']],
  mastersthesis: [['author'], ['title'], ['school', 'institution'], ['year', 'date']],
  techreport: [['author'], ['title'], ['institution'], ['year', 'date']],
  misc: [['title']],
  online: [['title'], ['url', 'doi', 'eprint']],
};

export function structuralChecks(entry: BibEntry | undefined, errors: ParseError[], strings: Map<string, ValuePart[]>): CheckResult[] {
  const out: CheckResult[] = [];
  if (!entry) {
    out.push({
      id: 'parse',
      label: 'BibTeX parsed',
      state: 'CONFLICT',
      detail: errors[0] ? `Line ${errors[0].line}: ${errors[0].message}` : 'No entry found.',
    });
    return out;
  }
  out.push({
    id: 'parse',
    label: 'BibTeX parsed',
    state: errors.length ? 'HIGH CONFIDENCE' : 'VERIFIED',
    detail: errors.length ? `Parsed with ${errors.length} problem(s) elsewhere in the input.` : undefined,
  });

  if (!KNOWN_ENTRY_TYPES.includes(entry.type))
    out.push({
      id: 'type',
      label: `Unknown entry type @${entry.type}`,
      state: 'UNVERIFIED',
      detail: 'BibTeX styles may ignore or mishandle this type.',
    });

  if (!entry.key) out.push({ id: 'key', label: 'Citation key is missing', state: 'CONFLICT' });
  else if (/[\s,{}"#%~\\]/.test(entry.key))
    out.push({ id: 'key', label: 'Citation key contains characters that break \\cite{}', state: 'CONFLICT', detail: entry.key });

  const names = entry.fields.map((f) => f.name.toLowerCase());
  const dups = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dups.length)
    out.push({
      id: 'dups',
      label: `Duplicate field${dups.length > 1 ? 's' : ''}: ${dups.join(', ')}`,
      state: 'CONFLICT',
      detail: 'BibTeX uses only one of them; Biber reports an error. Remove the duplicate by hand after deciding which is right.',
    });

  const req = REQUIRED[normalizeType(entry.type)];
  if (req) {
    const has = new Set(names);
    if (entry.fields.some((f) => f.name.toLowerCase() === 'crossref')) {
      // Required fields may be inherited; don't flag.
    } else {
      const missing = req.filter((alts) => !alts.some((a) => has.has(a))).map((a) => a.join(' or '));
      if (missing.length)
        out.push({
          id: 'required',
          label: `Missing required field${missing.length > 1 ? 's' : ''} for @${entry.type}: ${missing.join(', ')}`,
          state: 'MISSING',
        });
    }
  }

  const unresolved = new Set<string>();
  for (const f of entry.fields) valueToText(f.parts, strings).unresolved.forEach((m) => unresolved.add(m));
  if (unresolved.size)
    out.push({
      id: 'macros',
      label: `Undefined string macro${unresolved.size > 1 ? 's' : ''}: ${[...unresolved].join(', ')}`,
      state: 'UNVERIFIED',
      detail: 'Define it with @string in your .bib file, or it will print literally.',
    });

  for (const f of entry.fields) {
    const text = valueToText(f.parts, strings).text;
    const dollars = (text.match(/(?<!\\)\$/g) ?? []).length;
    if (dollars % 2 === 1) out.push({ id: `math-${f.name}`, label: `Unbalanced $ in ${f.name}`, state: 'CONFLICT' });
  }
  return out;
}
