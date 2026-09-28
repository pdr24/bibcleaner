import type { BibEntry } from '../../core/parser/bibtex';
import type { FieldComparison, Suggestion, VerificationState } from '../../core/models/types';

/**
 * The entry as the user wrote it, with a proofreader's mark in the margin of
 * each field line and pencilled-in lines for fields that could be added.
 * Clicking a mark jumps to the suggestion that explains it.
 */
type Mark = { glyph: string; tone: string; text: string; target?: string };

const fromState = (s: VerificationState): Mark | null => {
  switch (s) {
    case 'VERIFIED':
    case 'HIGH CONFIDENCE':
      return { glyph: '✓', tone: 'good', text: s === 'VERIFIED' ? 'verified' : 'matches, high confidence' };
    case 'CONFLICT':
      return { glyph: '!', tone: 'bad', text: 'conflicts with the matched record' };
    case 'UNREACHABLE':
      return { glyph: '×', tone: 'bad', text: 'unreachable' };
    case 'AMBIGUOUS':
      return { glyph: '?', tone: 'warn', text: 'ambiguous' };
    default:
      return null;
  }
};

const RANK: Record<string, number> = { bad: 4, warn: 3, info: 2, pencil: 1, good: 0 };

function lineOf(text: string, pos: number): number {
  let n = 0;
  for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export function ProofSheet({
  text,
  entry,
  comparisons,
  suggestions,
  onJump,
}: {
  text: string;
  entry: BibEntry;
  comparisons: FieldComparison[];
  suggestions: Suggestion[];
  onJump: (id: string) => void;
}) {
  const lines = text.split('\n');
  const first = lineOf(text, entry.start);
  const last = lineOf(text, entry.end - 1);
  const marks = new Map<number, Mark>();
  const put = (line: number, m: Mark | null) => {
    if (!m) return;
    const cur = marks.get(line);
    if (!cur || RANK[m.tone] > RANK[cur.tone]) marks.set(line, m);
  };
  const fieldLine = (name: string) => {
    const f = entry.fields.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return f ? lineOf(text, f.nameStart) : undefined;
  };
  for (const c of comparisons) {
    const ln = c.field === 'entry type' ? first : fieldLine(c.field);
    if (ln !== undefined) put(ln, fromState(c.status));
  }
  const additions: Suggestion[] = [];
  for (const s of suggestions) {
    if (s.accepted === false) continue;
    if (s.operation === 'add') {
      additions.push(s);
      continue;
    }
    const ln = s.field === 'KEY' || s.field === 'ENTRYTYPE' ? first : s.field === 'ENTRY' ? undefined : fieldLine(s.field);
    if (ln === undefined) continue;
    const m: Mark =
      s.category === 'conflict' || s.category === 'url'
        ? { glyph: '!', tone: 'bad', text: s.title, target: s.id }
        : s.category === 'version'
          ? { glyph: '↑', tone: 'info', text: s.title, target: s.id }
          : s.category === 'missing'
            ? { glyph: '+', tone: 'info', text: s.title, target: s.id }
            : { glyph: '~', tone: 'pencil', text: s.title, target: s.id };
    put(ln, m);
  }

  const body = lines.slice(first, last + 1);
  return (
    <figure className="proof" aria-label="Your entry with review marks">
      <div className="proof-sheet">
        {body.map((ln, i) => {
          const m = marks.get(first + i);
          const isClose = first + i === last;
          return (
            <div key={i}>
              {isClose
                ? additions.map((a) => (
                    <div key={a.id} className={`proof-line is-added ${a.accepted ? 'is-accepted' : ''}`}>
                      <button type="button" className="proof-margin tone-info" onClick={() => onJump(a.id)} title={a.title}>
                        <span aria-hidden="true">+</span>
                        <span className="sr-only">{a.title}, go to suggestion</span>
                      </button>
                      <code className="proof-code">
                        {'  '}
                        {a.field} = {'{'}
                        {a.suggestedValue}
                        {'}'}
                      </code>
                    </div>
                  ))
                : null}
              <div className="proof-line">
                {m?.target ? (
                  <button type="button" className={`proof-margin tone-${m.tone}`} onClick={() => onJump(m.target!)} title={m.text}>
                    <span aria-hidden="true">{m.glyph}</span>
                    <span className="sr-only">{m.text}, go to suggestion</span>
                  </button>
                ) : (
                  <span className={`proof-margin ${m ? `tone-${m.tone}` : ''}`} title={m?.text}>
                    <span aria-hidden="true">{m?.glyph ?? ''}</span>
                    {m ? <span className="sr-only">{m.text}</span> : null}
                  </span>
                )}
                <code className="proof-code">{ln || ' '}</code>
              </div>
            </div>
          );
        })}
      </div>
      <figcaption className="proof-legend">
        <span>
          <b className="tone-good">✓</b> matches
        </span>
        <span>
          <b className="tone-bad">!</b> conflict
        </span>
        <span>
          <b className="tone-info">+</b> can be added
        </span>
        <span>
          <b className="tone-pencil">~</b> formatting
        </span>
      </figcaption>
    </figure>
  );
}
