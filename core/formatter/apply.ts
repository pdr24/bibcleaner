import type { Suggestion } from '../models/types';
import type { BibEntry, BibField } from '../parser/bibtex';
import { parseBibtex } from '../parser/bibtex';
import { wrapTerm } from './capitalization';

/**
 * Produces the cleaned entry from the ORIGINAL text plus ONLY the accepted
 * suggestions. Nothing else changes: without an accepted layout suggestion,
 * edits are applied as minimal text patches and every other byte (spacing,
 * quoting, comments around the entry, unknown fields) is preserved.
 */

export const FIELD_ORDER = [
  'author',
  'editor',
  'title',
  'subtitle',
  'booktitle',
  'journal',
  'journaltitle',
  'series',
  'edition',
  'volume',
  'number',
  'issue',
  'pages',
  'articleno',
  'numpages',
  'year',
  'month',
  'date',
  'publisher',
  'organization',
  'address',
  'location',
  'school',
  'institution',
  'howpublished',
  'isbn',
  'issn',
  'doi',
  'url',
  'urldate',
  'eprint',
  'archiveprefix',
  'eprinttype',
  'primaryclass',
  'keywords',
  'abstract',
  'note',
];

interface Edit {
  start: number;
  end: number;
  text: string;
}

function braceValue(v: string): string {
  return `{${v}}`;
}

/** Inner text of a single-part braced/quoted value; undefined for macros/concatenations. */
export function simpleInner(f: BibField): string | undefined {
  if (f.parts.length !== 1) return undefined;
  const p = f.parts[0];
  if (p.kind === 'braced' || p.kind === 'quoted' || p.kind === 'number') return p.text;
  return undefined;
}

interface FieldPlan {
  name: string;
  /** New raw value (with delimiters), or undefined = unchanged. */
  raw?: string;
  rename?: string;
  remove?: boolean;
}

function lineIndent(src: string, pos: number): string {
  const ls = src.lastIndexOf('\n', pos - 1) + 1;
  const m = src.slice(ls, pos).match(/^[ \t]*/);
  return m ? m[0] : '';
}

function nameWidth(src: string, f: BibField): { width: number; spaceAfter: string } {
  const eq = src.indexOf('=', f.nameEnd);
  const between = src.slice(f.nameEnd, eq);
  const after = src.slice(eq + 1, f.valueStart);
  return { width: f.nameEnd - f.nameStart + between.length, spaceAfter: after.includes('\n') ? ' ' : after };
}

export interface ApplyResult {
  text: string;
  appliedIds: string[];
  skipped: { id: string; reason: string }[];
}

export function applySuggestions(entryText: string, suggestions: Suggestion[]): ApplyResult {
  const parsed = parseBibtex(entryText);
  const entry = parsed.entries[0];
  const accepted = suggestions.filter((s) => s.accepted === true);
  const result: ApplyResult = { text: entryText, appliedIds: [], skipped: [] };
  if (!entry) {
    for (const s of accepted) result.skipped.push({ id: s.id, reason: 'Entry could not be parsed' });
    return result;
  }

  let newType: string | undefined;
  let newKey: string | undefined;
  let layout = false;
  const plans = new Map<string, FieldPlan>();
  const plan = (name: string) => {
    const k = name.toLowerCase();
    if (!plans.has(k)) plans.set(k, { name });
    return plans.get(k)!;
  };
  const wraps = new Map<string, string[]>();
  const current = (name: string): string | undefined => {
    const p = plans.get(name.toLowerCase());
    if (p?.raw !== undefined) return p.raw.slice(1, -1);
    const f = entry.fields.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return f ? simpleInner(f) : undefined;
  };

  // Deterministic order: sets/renames/removes first, then wraps, then layout.
  const order = { set: 0, rename: 1, remove: 2, wrap: 3, layout: 4 } as const;
  for (const s of [...accepted].sort((a, b) => order[a.patch.kind] - order[b.patch.kind])) {
    const p = s.patch;
    if (s.field === 'ENTRY' && p.kind === 'layout') {
      layout = true;
    } else if (s.field === 'ENTRYTYPE' && p.kind === 'set') {
      newType = p.value;
    } else if (s.field === 'KEY' && p.kind === 'set') {
      newKey = p.value;
    } else if (p.kind === 'set') {
      plan(s.field).raw = braceValue(p.value);
    } else if (p.kind === 'rename') {
      if (!entry.fields.some((f) => f.name.toLowerCase() === s.field.toLowerCase())) {
        result.skipped.push({ id: s.id, reason: `Field ${s.field} is not present` });
        continue;
      }
      if (entry.fields.some((f) => f.name.toLowerCase() === p.to.toLowerCase()) || plans.get(p.to.toLowerCase())?.raw) {
        result.skipped.push({ id: s.id, reason: `A ${p.to} field already exists` });
        continue;
      }
      plan(s.field).rename = p.to;
    } else if (p.kind === 'remove') {
      plan(s.field).remove = true;
    } else if (p.kind === 'wrap') {
      if (current(s.field) === undefined) {
        result.skipped.push({ id: s.id, reason: `${s.field} uses a macro or concatenation; protect it manually` });
        continue;
      }
      wraps.set(s.field.toLowerCase(), [...(wraps.get(s.field.toLowerCase()) ?? []), p.term]);
    }
    result.appliedIds.push(s.id);
  }
  for (const [name, terms] of wraps) {
    let v = current(name)!;
    for (const t of terms) v = wrapTerm(v, t);
    const f = entry.fields.find((x) => x.name.toLowerCase() === name);
    const existing = f ? simpleInner(f) : undefined;
    // Keep quote delimiters if the field used them and nothing else changed it.
    if (v !== (plans.get(name)?.raw?.slice(1, -1) ?? existing)) {
      const quoted = f && !plans.get(name)?.raw && f.parts[0].kind === 'quoted';
      plan(name).raw = quoted ? `"${v}"` : braceValue(v);
    }
  }

  if (layout) {
    result.text = prettyPrint(entry, entryText, plans, newType, newKey);
    return result;
  }
  result.text = patch(entry, entryText, plans, newType, newKey);
  return result;
}

function patch(entry: BibEntry, src: string, plans: Map<string, FieldPlan>, newType?: string, newKey?: string): string {
  const edits: Edit[] = [];
  if (newType) edits.push({ start: entry.typeStart, end: entry.typeEnd, text: newType });
  if (newKey) edits.push({ start: entry.keyStart, end: entry.keyEnd, text: newKey });
  const inserts: { name: string; raw: string }[] = [];
  for (const [k, p] of plans) {
    const f = entry.fields.find((x) => x.name.toLowerCase() === k);
    if (!f) {
      if (p.raw && !p.remove) inserts.push({ name: p.name, raw: p.raw });
      continue;
    }
    if (p.remove) {
      edits.push(removalEdit(src, entry, f));
      continue;
    }
    if (p.rename) edits.push({ start: f.nameStart, end: f.nameEnd, text: p.rename });
    if (p.raw !== undefined) edits.push({ start: f.valueStart, end: f.valueEnd, text: p.raw });
  }
  if (inserts.length) edits.push(insertionEdit(src, entry, inserts));
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

function removalEdit(src: string, entry: BibEntry, f: BibField): Edit {
  let start = f.nameStart;
  let end = f.valueEnd;
  let j = end;
  while (j < entry.closePos && /\s/.test(src[j])) j++;
  if (src[j] === ',') end = j + 1;
  else {
    // Last field: remove the preceding comma instead.
    let k = start - 1;
    while (k > entry.keyEnd && /\s/.test(src[k])) k--;
    if (src[k] === ',') start = k;
  }
  // Remove the whole line when the field sat on its own line.
  const ls = src.lastIndexOf('\n', start - 1) + 1;
  const le = src.indexOf('\n', end);
  if (src.slice(ls, start).trim() === '' && le >= 0 && src.slice(end, le).trim() === '') {
    start = ls;
    end = le + 1;
  }
  return { start, end, text: '' };
}

function insertionEdit(src: string, entry: BibEntry, inserts: { name: string; raw: string }[]): Edit {
  const last = entry.fields[entry.fields.length - 1];
  if (!last) {
    const text = inserts.map((i) => `,\n  ${i.name} = ${i.raw}`).join('');
    return { start: entry.keyEnd, end: entry.keyEnd, text };
  }
  const multiline = src.slice(entry.keyEnd, entry.closePos).includes('\n');
  const indent = multiline ? lineIndent(src, last.nameStart) : ' ';
  const { spaceAfter } = nameWidth(src, last);
  // Aligned style = all fields end their name at the same column before '='.
  const gaps = entry.fields.map((f) => src.slice(f.nameEnd, src.indexOf('=', f.nameEnd)));
  const widths = entry.fields.map((f, i) => f.name.length + gaps[i].length);
  const aligned = entry.fields.length > 1 && new Set(gaps).size > 1 && new Set(widths).size === 1;
  const fmt = (name: string, raw: string) => {
    const gap = aligned ? ' '.repeat(Math.max(1, widths[0] - name.length)) : gaps[gaps.length - 1];
    return `${name}${gap}=${spaceAfter}${raw}`;
  };
  const sep = multiline ? '\n' + indent : ' ';
  let j = last.valueEnd;
  while (j < entry.closePos && /\s/.test(src[j])) j++;
  if (src[j] === ',') {
    // Trailing comma style: insert after it, each new field followed by a comma.
    const text = inserts.map((i) => `${sep}${fmt(i.name, i.raw)},`).join('');
    return { start: j + 1, end: j + 1, text };
  }
  const text = inserts.map((i) => `,${sep}${fmt(i.name, i.raw)}`).join('');
  return { start: last.valueEnd, end: last.valueEnd, text };
}

function rawValue(f: BibField, src: string): string {
  if (f.parts.length === 1 && f.parts[0].kind === 'quoted') return `{${f.parts[0].text}}`;
  if (f.parts.length === 1 && f.parts[0].kind === 'braced') return `{${f.parts[0].text}}`;
  return src.slice(f.valueStart, f.valueEnd);
}

const STANDARD = new Set(FIELD_ORDER);

function prettyPrint(entry: BibEntry, src: string, plans: Map<string, FieldPlan>, newType?: string, newKey?: string): string {
  const fields: { name: string; raw: string; origIndex: number }[] = [];
  const seen = new Set<string>();
  entry.fields.forEach((f, idx) => {
    const k = f.name.toLowerCase();
    const p = plans.get(k);
    if (p?.remove) return;
    let name = p?.rename ?? f.name;
    if (STANDARD.has(name.toLowerCase())) name = name.toLowerCase();
    // Duplicate fields are kept (never silently dropped); only the first gets planned edits.
    const first = !seen.has(k);
    seen.add(k);
    fields.push({ name, raw: first && p?.raw !== undefined ? p.raw : rawValue(f, src), origIndex: idx });
  });
  for (const [k, p] of plans) {
    if (!entry.fields.some((f) => f.name.toLowerCase() === k) && p.raw && !p.remove)
      fields.push({ name: p.name.toLowerCase(), raw: p.raw, origIndex: 10_000 });
  }
  const pos = (n: string) => {
    const i = FIELD_ORDER.indexOf(n.toLowerCase());
    return i < 0 ? FIELD_ORDER.length : i;
  };
  fields.sort((a, b) => pos(a.name) - pos(b.name) || a.origIndex - b.origIndex);
  const w = Math.max(...fields.map((f) => f.name.length), 0);
  const type = newType ?? entry.type.toLowerCase();
  const key = newKey ?? entry.key;
  const body = fields.map((f) => `  ${f.name.padEnd(w)} = ${f.raw}`).join(',\n');
  return `@${type}{${key}${body ? ',\n' + body : ''}\n}`;
}
