/**
 * LaTeX <-> Unicode helpers. Decoding is used only for comparison and
 * display; the user's stored text is never rewritten by these functions.
 */

const ACCENTS: Record<string, string> = {
  "'": '\u0301',
  '`': '\u0300',
  '^': '\u0302',
  '"': '\u0308',
  '~': '\u0303',
  '=': '\u0304',
  '.': '\u0307',
  u: '\u0306',
  v: '\u030C',
  H: '\u030B',
  c: '\u0327',
  k: '\u0328',
  r: '\u030A',
  d: '\u0323',
  b: '\u0331',
};

const SYMBOLS: Record<string, string> = {
  ss: 'ß',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  o: 'ø',
  O: 'Ø',
  aa: 'å',
  AA: 'Å',
  l: 'ł',
  L: 'Ł',
  i: 'ı',
  j: 'ȷ',
  dh: 'ð',
  DH: 'Ð',
  th: 'þ',
  TH: 'Þ',
  ng: 'ŋ',
  NG: 'Ŋ',
  textendash: '–',
  textemdash: '—',
  textasciitilde: '~',
  textbackslash: '\\',
  textquotedblleft: '“',
  textquotedblright: '”',
  textquoteleft: '‘',
  textquoteright: '’',
  S: '§',
  P: '¶',
  copyright: '©',
  dag: '†',
  ddag: '‡',
  ldots: '…',
  dots: '…',
  textregistered: '®',
  texttrademark: '™',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  tau: 'τ',
  theta: 'θ',
  omega: 'ω',
};

const ESCAPED = new Set(['&', '%', '$', '#', '_', '{', '}']);

/**
 * Converts LaTeX-encoded text to Unicode. Braces are removed; unknown
 * commands are dropped (their arguments kept). Linear time, no regex
 * backtracking.
 */
export function latexToUnicode(input: string): string {
  let out = '';
  let i = 0;
  const s = input;
  const readArg = (): string => {
    while (s[i] === ' ') i++;
    if (s[i] === '{') {
      let depth = 1;
      const start = ++i;
      while (i < s.length && depth > 0) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') depth--;
        i++;
      }
      return s.slice(start, i - 1);
    }
    if (s[i] === '\\') {
      // e.g. \'{\i}
      const start = i;
      i++;
      while (i < s.length && /[A-Za-z]/.test(s[i])) i++;
      return s.slice(start, i);
    }
    return s[i++] ?? '';
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i++;
      const n = s[i] ?? '';
      if (ESCAPED.has(n)) {
        out += n;
        i++;
      } else if (n === '\\') {
        out += ' ';
        i++;
      } else if (ACCENTS[n] && !/[A-Za-z]/.test(n)) {
        i++;
        const arg = latexToUnicode(readArg()).replace(/^ı/, 'i').replace(/^ȷ/, 'j');
        out += arg ? (arg[0] + ACCENTS[n] + arg.slice(1)).normalize('NFC') : '';
      } else if (/[A-Za-z]/.test(n)) {
        const start = i;
        while (i < s.length && /[A-Za-z]/.test(s[i])) i++;
        const name = s.slice(start, i);
        if (ACCENTS[name] && name.length === 1) {
          const arg = latexToUnicode(readArg()).replace(/^ı/, 'i').replace(/^ȷ/, 'j');
          out += arg ? (arg[0] + ACCENTS[name] + arg.slice(1)).normalize('NFC') : '';
        } else if (SYMBOLS[name] !== undefined) {
          out += SYMBOLS[name];
          if (s[i] === '{' && s[i + 1] === '}') i += 2;
          else if (s[i] === ' ') i++;
        } else {
          // Unknown command (\emph, \textit, \mathrm ...) — keep its content.
          if (s[i] === ' ') i++;
        }
      } else {
        i++;
      }
    } else if (c === '{' || c === '}') {
      i++;
    } else if (c === '~') {
      out += ' ';
      i++;
    } else if (c === '-' && s[i + 1] === '-') {
      if (s[i + 2] === '-') {
        out += '—';
        i += 3;
      } else {
        out += '–';
        i += 2;
      }
    } else if (c === '`' && s[i + 1] === '`') {
      out += '“';
      i += 2;
    } else if (c === "'" && s[i + 1] === "'") {
      out += '”';
      i += 2;
    } else if (c === '$') {
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out.normalize('NFC');
}

const REVERSE_ACCENTS: Record<string, string> = Object.fromEntries(Object.entries(ACCENTS).map(([k, v]) => [v, k]));
const REVERSE_SYMBOLS: Record<string, string> = {
  ß: '{\\ss}',
  æ: '{\\ae}',
  Æ: '{\\AE}',
  œ: '{\\oe}',
  Œ: '{\\OE}',
  ø: '{\\o}',
  Ø: '{\\O}',
  å: '{\\aa}',
  Å: '{\\AA}',
  ł: '{\\l}',
  Ł: '{\\L}',
  ı: '{\\i}',
  '–': '--',
  '—': '---',
  '“': '``',
  '”': "''",
  '‘': '`',
  '’': "'",
  '…': '\\ldots{}',
};

/**
 * Encodes external Unicode metadata for safe inclusion in a BibTeX value:
 * escapes LaTeX specials and (optionally) converts accented Latin letters to
 * LaTeX accent commands for pdfLaTeX/BibTeX compatibility.
 */
export function unicodeToLatex(input: string, opts: { accents: boolean } = { accents: true }): string {
  let out = '';
  for (const ch of input.normalize('NFC')) {
    if (ch === '&' || ch === '%' || ch === '#' || ch === '_') {
      out += '\\' + ch;
      continue;
    }
    if (ch === '{' || ch === '}') {
      // Brace characters from external text would unbalance the value.
      continue;
    }
    if (ch === '\\') {
      out += '\\textbackslash{}';
      continue;
    }
    if (!opts.accents || ch.charCodeAt(0) < 128) {
      out += ch;
      continue;
    }
    if (REVERSE_SYMBOLS[ch]) {
      out += REVERSE_SYMBOLS[ch];
      continue;
    }
    const decomposed = ch.normalize('NFD');
    const base = decomposed[0];
    const marks = decomposed.slice(1);
    if (marks.length === 1 && REVERSE_ACCENTS[marks] && /[A-Za-z]/.test(base)) {
      const cmd = REVERSE_ACCENTS[marks];
      const b = base === 'i' && cmd !== 'c' ? '\\i' : base;
      out += /[A-Za-z]/.test(cmd) ? `{\\${cmd}{${b}}}` : `{\\${cmd}${b}}`;
    } else out += ch;
  }
  return out;
}

/** Removes simple HTML/JATS/MathML tags that Crossref sometimes embeds in titles. */
export function stripMarkup(input: string): { text: string; hadMarkup: boolean } {
  let out = '';
  let hadMarkup = false;
  let i = 0;
  while (i < input.length) {
    if (input[i] === '<') {
      const close = input.indexOf('>', i);
      if (close > i && close - i < 200 && /^<\/?[A-Za-z][\w:.-]*(\s[^<>]*)?\/?>$/.test(input.slice(i, close + 1))) {
        hadMarkup = true;
        i = close + 1;
        continue;
      }
    }
    out += input[i++];
  }
  const decoded = out
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d{1,6});/g, (_, d) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)));
  return { text: decoded.replace(/\s+/g, ' ').trim(), hadMarkup };
}
