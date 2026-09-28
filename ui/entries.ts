import { fieldText, parseBibtex, type BibEntry, type ValuePart } from '../core/parser/bibtex';
import { latexToUnicode } from '../core/normalize/latex';

export interface EntryChoice {
  index: number;
  key: string;
  type: string;
  title?: string;
  year?: string;
  text: string;
}

export interface EntryList {
  choices: EntryChoice[];
  context: { entries: BibEntry[]; strings: Map<string, ValuePart[]> };
  keys: Set<string>;
  errorCount: number;
}

/** Lists the entries in a pasted selection or .bib file. Parsing is local only. */
export function listEntries(text: string): EntryList {
  const p = parseBibtex(text);
  const choices = p.entries.map((e, index) => {
    const t = fieldText(e, 'title', p.strings);
    return {
      index,
      key: e.key,
      type: e.type.toLowerCase(),
      title: t ? latexToUnicode(t) : undefined,
      year: fieldText(e, 'year', p.strings),
      text: e.text,
    };
  });
  return {
    choices,
    context: { entries: p.entries, strings: p.strings },
    keys: new Set(p.entries.map((e) => e.key)),
    errorCount: p.errors.length,
  };
}

export function filterChoices(list: EntryChoice[], q: string): EntryChoice[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return list;
  return list.filter(
    (c) => c.key.toLowerCase().includes(needle) || (c.title ?? '').toLowerCase().includes(needle) || (c.year ?? '').includes(needle),
  );
}
