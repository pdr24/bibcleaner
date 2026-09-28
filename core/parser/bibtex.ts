/**
 * Span-preserving BibTeX / BibLaTeX parser.
 *
 * Why a purpose-built scanner instead of an off-the-shelf parser: BibCleaner's
 * core promise is that unapproved text never changes. That requires exact
 * source offsets for every field name and value so approved edits can be
 * applied as minimal patches while everything else (comments, spacing,
 * quoting style, unknown fields, macros) is byte-for-byte preserved.
 * Existing JS parsers normalise values on parse and do not expose spans.
 *
 * The scanner is a single forward pass with explicit depth counters — no
 * recursion and no backtracking regular expressions — and enforces size
 * limits so malformed or hostile input cannot hang the UI.
 */

export const LIMITS = {
  maxFileChars: 5_000_000,
  maxEntryChars: 100_000,
  maxFieldChars: 20_000,
  maxBraceDepth: 64,
  maxFieldsPerEntry: 200,
  maxEntries: 20_000,
};

export type ValuePart =
  { kind: 'braced'; text: string } | { kind: 'quoted'; text: string } | { kind: 'number'; text: string } | { kind: 'macro'; name: string };

export interface BibField {
  name: string;
  /** Offsets are absolute positions in the parsed source text. */
  nameStart: number;
  nameEnd: number;
  valueStart: number;
  valueEnd: number;
  raw: string;
  parts: ValuePart[];
}

export interface BibEntry {
  kind: 'entry';
  type: string;
  typeStart: number;
  typeEnd: number;
  key: string;
  keyStart: number;
  keyEnd: number;
  fields: BibField[];
  /** Position of '@'. */
  start: number;
  /** Position just after the closing delimiter. */
  end: number;
  /** Position of the closing delimiter. */
  closePos: number;
  openDelim: '{' | '(';
  text: string;
}

export interface BibStringDef {
  kind: 'string';
  name: string;
  parts: ValuePart[];
  start: number;
  end: number;
}

export interface BibPreamble {
  kind: 'preamble';
  parts: ValuePart[];
  start: number;
  end: number;
}

export interface BibComment {
  kind: 'comment';
  text: string;
  start: number;
  end: number;
}

export type BibItem = BibEntry | BibStringDef | BibPreamble | BibComment;

export interface ParseError {
  message: string;
  position: number;
  line: number;
}

export interface ParseResult {
  source: string;
  items: BibItem[];
  entries: BibEntry[];
  strings: Map<string, ValuePart[]>;
  errors: ParseError[];
}

export const MONTH_MACROS: Record<string, string> = {
  jan: 'January',
  feb: 'February',
  mar: 'March',
  apr: 'April',
  may: 'May',
  jun: 'June',
  jul: 'July',
  aug: 'August',
  sep: 'September',
  oct: 'October',
  nov: 'November',
  dec: 'December',
};

class BibSyntaxError extends Error {
  constructor(
    message: string,
    public position: number,
  ) {
    super(message);
  }
}

const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
// Identifier characters allowed in BibTeX names and keys.
const isIdentChar = (c: string) =>
  c !== '' &&
  !isWs(c) &&
  c !== '{' &&
  c !== '}' &&
  c !== '(' &&
  c !== ')' &&
  c !== ',' &&
  c !== '=' &&
  c !== '"' &&
  c !== '#' &&
  c !== '@' &&
  c !== '%';

function lineOf(src: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

class Scanner {
  i: number;
  constructor(
    public src: string,
    start = 0,
  ) {
    this.i = start;
  }
  peek(): string {
    return this.src[this.i] ?? '';
  }
  eof(): boolean {
    return this.i >= this.src.length;
  }
  skipWs(): void {
    while (!this.eof() && isWs(this.src[this.i])) this.i++;
  }
  expect(ch: string): void {
    if (this.peek() !== ch) throw new BibSyntaxError(`Expected "${ch}" but found "${this.peek() || 'end of input'}"`, this.i);
    this.i++;
  }
  ident(what: string): { text: string; start: number; end: number } {
    const start = this.i;
    while (!this.eof() && isIdentChar(this.src[this.i])) this.i++;
    if (this.i === start) throw new BibSyntaxError(`Expected ${what}`, start);
    return { text: this.src.slice(start, this.i), start, end: this.i };
  }
  /** Reads a {...} group; returns inner text. Counts braces exactly like BibTeX. */
  braced(): string {
    const open = this.i;
    this.expect('{');
    let depth = 1;
    const start = this.i;
    while (!this.eof()) {
      const c = this.src[this.i];
      if (c === '{') {
        depth++;
        if (depth > LIMITS.maxBraceDepth) throw new BibSyntaxError('Braces nested too deeply', this.i);
      } else if (c === '}') {
        depth--;
        if (depth === 0) {
          const text = this.src.slice(start, this.i);
          this.i++;
          if (text.length > LIMITS.maxFieldChars) throw new BibSyntaxError('Field value too long', start);
          return text;
        }
      }
      this.i++;
    }
    throw new BibSyntaxError('Unbalanced braces: missing "}"', open);
  }
  quoted(): string {
    const open = this.i;
    this.expect('"');
    let depth = 0;
    const start = this.i;
    while (!this.eof()) {
      const c = this.src[this.i];
      if (c === '{') {
        depth++;
        if (depth > LIMITS.maxBraceDepth) throw new BibSyntaxError('Braces nested too deeply', this.i);
      } else if (c === '}') {
        depth--;
        if (depth < 0) throw new BibSyntaxError('Unbalanced "}" inside quoted value', this.i);
      } else if (c === '"' && depth === 0) {
        const text = this.src.slice(start, this.i);
        this.i++;
        if (text.length > LIMITS.maxFieldChars) throw new BibSyntaxError('Field value too long', start);
        return text;
      }
      this.i++;
    }
    throw new BibSyntaxError('Unterminated quoted value', open);
  }
  value(): { parts: ValuePart[]; start: number; end: number } {
    const parts: ValuePart[] = [];
    const start = this.i;
    let end = this.i;
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === '{') parts.push({ kind: 'braced', text: this.braced() });
      else if (c === '"') parts.push({ kind: 'quoted', text: this.quoted() });
      else if (c >= '0' && c <= '9') {
        const s = this.i;
        while (!this.eof() && /[0-9]/.test(this.src[this.i])) this.i++;
        parts.push({ kind: 'number', text: this.src.slice(s, this.i) });
      } else if (isIdentChar(c)) {
        parts.push({ kind: 'macro', name: this.ident('macro name').text });
      } else throw new BibSyntaxError('Expected a field value', this.i);
      end = this.i;
      this.skipWs();
      if (this.peek() === '#') {
        this.i++;
        continue;
      }
      break;
    }
    return { parts, start, end };
  }
}

function closingFor(open: '{' | '('): string {
  return open === '{' ? '}' : ')';
}

/** Finds a safe place to resume after a syntax error: the next '@' that starts a line. */
function resync(src: string, from: number): number {
  let i = from + 1;
  while (i < src.length) {
    if (src[i] === '@' && (i === 0 || src[i - 1] === '\n' || /\s/.test(src[i - 1]))) return i;
    i++;
  }
  return src.length;
}

export function parseBibtex(source: string): ParseResult {
  const result: ParseResult = { source, items: [], entries: [], strings: new Map(), errors: [] };
  if (source.length > LIMITS.maxFileChars) {
    result.errors.push({ message: `Input is larger than ${LIMITS.maxFileChars.toLocaleString()} characters`, position: 0, line: 1 });
    return result;
  }
  let pos = 0;
  let commentStart = 0;
  const flushComment = (upTo: number) => {
    if (upTo > commentStart) {
      const text = source.slice(commentStart, upTo);
      if (text.trim()) result.items.push({ kind: 'comment', text, start: commentStart, end: upTo });
    }
  };

  while (pos < source.length) {
    const at = source.indexOf('@', pos);
    if (at < 0) break;
    const s = new Scanner(source, at + 1);
    try {
      s.skipWs();
      const typeTok = s.ident('entry type after "@"');
      const type = typeTok.text.toLowerCase();
      s.skipWs();
      const open = s.peek();
      if (open !== '{' && open !== '(') {
        // Stray '@' in free text (e.g. an e-mail address). BibTeX treats it as comment.
        pos = at + 1;
        continue;
      }
      flushComment(at);
      s.i++;
      const close = closingFor(open as '{' | '(');

      if (type === 'comment') {
        // @comment{...}: skip a balanced group.
        s.i--;
        if (open === '{') s.braced();
        else {
          const endIdx = source.indexOf(')', s.i);
          s.i = endIdx < 0 ? source.length : endIdx + 1;
        }
        result.items.push({ kind: 'comment', text: source.slice(at, s.i), start: at, end: s.i });
      } else if (type === 'preamble') {
        const v = s.value();
        s.skipWs();
        s.expect(close);
        result.items.push({ kind: 'preamble', parts: v.parts, start: at, end: s.i });
      } else if (type === 'string') {
        s.skipWs();
        const name = s.ident('string name').text;
        s.skipWs();
        s.expect('=');
        const v = s.value();
        s.skipWs();
        s.expect(close);
        result.strings.set(name.toLowerCase(), v.parts);
        result.items.push({ kind: 'string', name, parts: v.parts, start: at, end: s.i });
      } else {
        s.skipWs();
        const keyStart = s.i;
        while (!s.eof() && s.peek() !== ',' && s.peek() !== close && !isWs(s.peek())) s.i++;
        const key = source.slice(keyStart, s.i);
        const keyEnd = s.i;
        s.skipWs();
        const fields: BibField[] = [];
        // A key followed by anything other than "," or the closing delimiter is
        // almost always a key containing a space; say so instead of failing on
        // the field that follows it.
        if (s.peek() !== ',' && s.peek() !== close && !s.eof())
          throw new BibSyntaxError(
            `Citation key "${key}" is followed by "${s.peek()}". BibTeX keys cannot contain spaces or braces.`,
            keyEnd,
          );
        if (s.peek() === ',') s.i++;
        for (;;) {
          s.skipWs();
          if (s.peek() === close) break;
          if (s.eof()) throw new BibSyntaxError(`Entry "${key}" is missing its closing "${close}"`, at);
          const nameTok = s.ident('field name');
          s.skipWs();
          s.expect('=');
          const v = s.value();
          fields.push({
            name: nameTok.text,
            nameStart: nameTok.start,
            nameEnd: nameTok.end,
            valueStart: v.start + (source.slice(v.start, v.end).length - source.slice(v.start, v.end).trimStart().length),
            valueEnd: v.end,
            raw: source.slice(v.start, v.end).trim(),
            parts: v.parts,
          });
          if (fields.length > LIMITS.maxFieldsPerEntry) throw new BibSyntaxError('Too many fields in one entry', nameTok.start);
          s.skipWs();
          if (s.peek() === ',') {
            s.i++;
            continue;
          }
          if (s.peek() === close) break;
          if (s.eof()) throw new BibSyntaxError(`Entry "${key}" is missing its closing "${close}"`, at);
          throw new BibSyntaxError(`Expected "," or "${close}" after field "${nameTok.text}"`, s.i);
        }
        const closePos = s.i;
        s.i++;
        if (s.i - at > LIMITS.maxEntryChars) throw new BibSyntaxError('Entry is too large to analyze', at);
        const entry: BibEntry = {
          kind: 'entry',
          type,
          typeStart: typeTok.start,
          typeEnd: typeTok.end,
          key,
          keyStart,
          keyEnd,
          fields,
          start: at,
          end: s.i,
          closePos,
          openDelim: open as '{' | '(',
          text: source.slice(at, s.i),
        };
        result.items.push(entry);
        result.entries.push(entry);
        if (result.entries.length > LIMITS.maxEntries) {
          result.errors.push({ message: 'Too many entries; stopped parsing', position: s.i, line: lineOf(source, s.i) });
          return result;
        }
      }
      pos = s.i;
      commentStart = pos;
    } catch (e) {
      if (!(e instanceof BibSyntaxError)) throw e;
      result.errors.push({ message: e.message, position: e.position, line: lineOf(source, e.position) });
      const next = resync(source, at);
      commentStart = next;
      pos = next;
    }
  }
  flushComment(source.length);
  return result;
}

/** Re-parses an entry's own text so its offsets are relative to `entry.text`. */
export function parseSingleEntry(text: string): { entry?: BibEntry; errors: ParseError[]; strings: Map<string, ValuePart[]> } {
  const r = parseBibtex(text);
  return { entry: r.entries[0], errors: r.errors, strings: r.strings };
}

/** Expands a parsed value into plain (still LaTeX-encoded) text. */
export function valueToText(
  parts: ValuePart[],
  strings: Map<string, ValuePart[]> = new Map(),
  depth = 0,
): { text: string; unresolved: string[] } {
  let text = '';
  const unresolved: string[] = [];
  for (const p of parts) {
    if (p.kind === 'macro') {
      const name = p.name.toLowerCase();
      const def = strings.get(name);
      if (def && depth < 8) {
        const inner = valueToText(def, strings, depth + 1);
        text += inner.text;
        unresolved.push(...inner.unresolved);
      } else if (MONTH_MACROS[name]) text += MONTH_MACROS[name];
      else {
        text += p.name;
        unresolved.push(p.name);
      }
    } else text += p.text;
  }
  return { text, unresolved };
}

/** Plain text of a field (macros expanded), or undefined when absent. */
export function fieldText(entry: BibEntry, name: string, strings?: Map<string, ValuePart[]>): string | undefined {
  const f = entry.fields.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return f ? valueToText(f.parts, strings).text : undefined;
}

export function getField(entry: BibEntry, name: string): BibField | undefined {
  return entry.fields.find((x) => x.name.toLowerCase() === name.toLowerCase());
}

/**
 * Fields inherited through `crossref` / `xdata` from other entries in the same
 * file. Used for comparison only; never written back.
 */
export function inheritedFields(entry: BibEntry, all: BibEntry[], strings?: Map<string, ValuePart[]>): Map<string, string> {
  const out = new Map<string, string>();
  const refs: string[] = [];
  for (const name of ['crossref', 'xdata']) {
    const v = fieldText(entry, name, strings);
    if (v)
      refs.push(
        ...v
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      );
  }
  for (const ref of refs) {
    const parent = all.find((e) => e.key.toLowerCase() === ref.toLowerCase());
    if (!parent) continue;
    for (const f of parent.fields) {
      let name = f.name.toLowerCase();
      // BibLaTeX-style inheritance of the parent's title as booktitle.
      if (name === 'title' && entry.type !== parent.type) name = 'booktitle';
      if (!out.has(name) && !getField(entry, name)) out.set(name, valueToText(f.parts, strings).text);
    }
  }
  return out;
}

export const KNOWN_ENTRY_TYPES = [
  'article',
  'inproceedings',
  'conference',
  'proceedings',
  'book',
  'inbook',
  'incollection',
  'phdthesis',
  'mastersthesis',
  'techreport',
  'misc',
  'online',
  'software',
  'dataset',
  'unpublished',
  'manual',
  'booklet',
  'thesis',
  'report',
  'collection',
  'electronic',
  'www',
  'patent',
  'periodical',
  'suppbook',
  'suppcollection',
  'reference',
  'mvbook',
  'mvcollection',
  'mvproceedings',
  'bookinbook',
  'inreference',
  'set',
  'xdata',
  'preprint',
];
