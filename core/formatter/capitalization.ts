/**
 * Detects title terms whose capitalization carries meaning and would be
 * lowercased by sentence-case bibliography styles (e.g. ACM, IEEE with some
 * .bst files): acronyms (AI), mixed case (IoT, iPhone, GitHub), terms with
 * digits (5G, GPT-4), and a short list of proper names common in CS.
 * These are suggestions only — detection is heuristic.
 */

const PROPER_NAMES = new Set([
  'Python',
  'Java',
  'Linux',
  'Android',
  'Windows',
  'Unix',
  'Bayesian',
  'Markov',
  'Gaussian',
  'Boolean',
  'Euclidean',
  'Turing',
  'Scratch',
  'Snap',
  'Rust',
  'Haskell',
  'Kotlin',
  'Swift',
  'Excel',
  'Minecraft',
  'Arduino',
  'Raspberry',
  'Pi',
  'English',
  'Spanish',
  'Chinese',
  'Hindi',
  'Wikipedia',
  'Twitter',
  'Reddit',
  'Google',
  'Microsoft',
  'Amazon',
  'Ethereum',
  'Bitcoin',
  'Dirichlet',
  'Fourier',
  'Hilbert',
  'Riemann',
  'Nash',
  'Pareto',
  'Monte',
  'Carlo',
  'Hamiltonian',
  'Laplacian',
]);

export interface ProtectionTerm {
  term: string;
  kind: 'acronym' | 'mixed-case' | 'proper-name';
}

interface Part {
  text: string;
  start: number;
}

/** Word parts at brace depth 0, outside math and LaTeX commands. */
function unprotectedParts(value: string): Part[] {
  const parts: Part[] = [];
  let depth = 0;
  let math = false;
  let i = 0;
  while (i < value.length) {
    const c = value[i];
    if (c === '\\') {
      i++;
      while (i < value.length && /[A-Za-z]/.test(value[i])) i++;
      if (i === value.length || !/[A-Za-z]/.test(value[i - 1])) i++;
      continue;
    }
    if (c === '$') {
      math = !math;
      i++;
      continue;
    }
    if (c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === '}') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0 && !math && /[A-Za-z0-9]/.test(c)) {
      const start = i;
      while (i < value.length && /[A-Za-z0-9]/.test(value[i])) i++;
      parts.push({ text: value.slice(start, i), start });
      continue;
    }
    i++;
  }
  return parts;
}

export function detectProtectionTerms(title: string): ProtectionTerm[] {
  const parts = unprotectedParts(title);
  const words = parts.filter((p) => /[A-Za-z]/.test(p.text));
  if (!words.length) return [];
  const allCapsWords = words.filter((w) => w.text.length > 1 && w.text === w.text.toUpperCase() && /[A-Z]/.test(w.text)).length;
  // A title typed in ALL CAPS is not evidence of acronyms.
  if (words.length >= 4 && allCapsWords / words.length > 0.6) return [];
  const out = new Map<string, ProtectionTerm>();
  words.forEach((p, idx) => {
    const t = p.text;
    const upperAfterFirst = /[A-Z]/.test(t.slice(1));
    const hasDigit = /\d/.test(t);
    if (t.length >= 2 && t === t.toUpperCase() && /[A-Z]/.test(t)) out.set(t, { term: t, kind: 'acronym' });
    else if (upperAfterFirst) out.set(t, { term: t, kind: hasDigit ? 'acronym' : 'mixed-case' });
    else if (idx > 0 && PROPER_NAMES.has(t)) out.set(t, { term: t, kind: 'proper-name' });
  });
  return [...out.values()];
}

/** Wraps every unprotected whole-part occurrence of `term` in braces. */
export function wrapTerm(value: string, term: string): string {
  const parts = unprotectedParts(value).filter((p) => p.text === term);
  let out = value;
  for (const p of parts.reverse()) out = out.slice(0, p.start) + '{' + term + '}' + out.slice(p.start + term.length);
  return out;
}
