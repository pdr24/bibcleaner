import type { Confidence, LookupStatus, VerificationState } from '../../core/models/types';

type Tone = 'good' | 'bad' | 'warn' | 'info' | 'quiet';

const STATE: Record<VerificationState, { glyph: string; tone: Tone; text: string }> = {
  VERIFIED: { glyph: '✓', tone: 'good', text: 'Verified' },
  'HIGH CONFIDENCE': { glyph: '✓', tone: 'good', text: 'High confidence' },
  AMBIGUOUS: { glyph: '?', tone: 'warn', text: 'Ambiguous' },
  UNVERIFIED: { glyph: '–', tone: 'quiet', text: 'Unverified' },
  CONFLICT: { glyph: '!', tone: 'bad', text: 'Conflict' },
  UNREACHABLE: { glyph: '×', tone: 'bad', text: 'Unreachable' },
  'NOT CHECKED': { glyph: '○', tone: 'quiet', text: 'Not checked' },
  MISSING: { glyph: '+', tone: 'info', text: 'Missing' },
};

export const stateInfo = (s: VerificationState) => STATE[s];

/** Glyph + words, never colour alone (PRD §25). */
export function StateMark({ state, compact = false }: { state: VerificationState; compact?: boolean }) {
  const s = STATE[state];
  return (
    <span className={`mark tone-${s.tone}`}>
      <span className="mark-glyph" aria-hidden="true">
        {s.glyph}
      </span>
      {compact ? <span className="sr-only">{s.text}</span> : <span className="mark-text">{s.text}</span>}
    </span>
  );
}

const LOOKUP: Record<LookupStatus | 'PENDING' | 'SKIPPED', { glyph: string; tone: Tone; text: string }> = {
  PENDING: { glyph: '◌', tone: 'quiet', text: 'checking' },
  SKIPPED: { glyph: '–', tone: 'quiet', text: 'skipped' },
  OK: { glyph: '✓', tone: 'good', text: 'found a record' },
  'NO RECORD FOUND': { glyph: '○', tone: 'quiet', text: 'no record found' },
  'LOOKUP FAILED': { glyph: '!', tone: 'warn', text: 'could not be checked' },
  'RATE LIMITED': { glyph: '!', tone: 'warn', text: 'rate limited, could not be checked' },
  'NETWORK UNAVAILABLE': { glyph: '!', tone: 'warn', text: 'offline, could not be checked' },
};

export const lookupInfo = (s: keyof typeof LOOKUP) => LOOKUP[s];

export function confidenceText(c: Confidence): string {
  return c === 'VERY HIGH' ? 'Very high confidence' : c === 'HIGH' ? 'High confidence' : c === 'POSSIBLE' ? 'Possible' : 'Low confidence';
}
