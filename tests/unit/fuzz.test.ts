/**
 * Robustness pass (PRD phase 7): the parser and the patcher must survive
 * arbitrary bytes. Untrusted input includes anything copied from a web page.
 */
import { parseBibtex } from '../../core/parser/bibtex';
import { applySuggestions } from '../../core/formatter/apply';
import { buildInput } from '../../core/verification/input';
import { structuralChecks } from '../../core/verification/structural';

// Deterministic PRNG so failures are reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

const ALPHABET = [
  '@',
  '{',
  '}',
  '"',
  '=',
  ',',
  '\\',
  '%',
  '#',
  '$',
  ' ',
  '\n',
  '\t',
  'a',
  'Z',
  '0',
  'é',
  '中',
  '\u0000',
  'article',
  'title',
  'and others',
  '\\"{u}',
  'http://x',
];

const seedCorpus = [
  '@article{k, title={T}, author={A}, year={2020}}',
  '@string{acm = {ACM}}\n@inproceedings{k, booktitle = acm # { Conf}, title = "Q"}',
  '@misc{k, note={{nested {braces} here}}, doi={10.1/x}}',
];

describe('fuzzing the parser and patcher', () => {
  it('never throws and always terminates on random input', () => {
    const rand = rng(20260922);
    for (let i = 0; i < 400; i++) {
      let s = seedCorpus[i % seedCorpus.length];
      const edits = 1 + Math.floor(rand() * 8);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(rand() * (s.length + 1));
        const tok = ALPHABET[Math.floor(rand() * ALPHABET.length)];
        s = rand() < 0.35 ? s.slice(0, at) + s.slice(at + 1 + Math.floor(rand() * 5)) : s.slice(0, at) + tok + s.slice(at);
      }
      const started = Date.now();
      const p = parseBibtex(s);
      expect(Date.now() - started).toBeLessThan(500);
      // Structural checks and input building must cope with whatever came out.
      expect(() => structuralChecks(p.entries[0], p.errors, p.strings)).not.toThrow();
      if (p.entries[0]) {
        expect(() => buildInput(p.entries[0], p.strings, p.entries)).not.toThrow();
        // With nothing accepted, the text is returned byte for byte (Rule 1).
        expect(applySuggestions(s, []).text).toBe(s);
      }
    }
  });

  it('handles adversarial nesting and long values within limits', () => {
    const deep = '@article{k, title={' + '{'.repeat(200) + 'x' + '}'.repeat(200) + '}}';
    const long = '@article{k, title={' + 'a'.repeat(300_000) + '}}';
    for (const s of [deep, long, '@'.repeat(5000), '@article{'.repeat(2000)]) {
      const started = Date.now();
      expect(() => parseBibtex(s)).not.toThrow();
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });
});
