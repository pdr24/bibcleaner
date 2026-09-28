/**
 * Pure review-state logic (no React, no chrome). Kept separate so the
 * approval rules can be unit tested: nothing is accepted by default,
 * alternatives in a group are mutually exclusive, and bulk actions never
 * touch the changes that need their own decision.
 */
import type { Suggestion } from '../../core/models/types';

export type Decision = boolean | null;

/** Stable identity for a suggestion across re-evaluation (ids are regenerated). */
export const decisionKey = (s: Suggestion): string => `${s.field}|${s.patch.kind}|${s.suggestedValue}`;

/**
 * Changes that "Accept all" deliberately skips:
 *  - citation-key renames (they can break \cite{} elsewhere, PRD §32), and
 *  - preprint → published conversions (PRD §18, Rule 6: the user must choose).
 */
export const needsOwnDecision = (s: Suggestion): boolean => s.category === 'key' || s.category === 'version';

export function decide(list: Suggestion[], id: string, value: Decision): Suggestion[] {
  const target = list.find((s) => s.id === id);
  if (!target) return list;
  return list.map((s) => {
    if (s.id === id) return { ...s, accepted: value };
    // Accepting one alternative rejects the others in its group.
    if (value === true && target.group && s.group === target.group && s.accepted === true) return { ...s, accepted: false };
    return s;
  });
}

/** Accept every bulk-eligible suggestion; within a group only the first (preferred) alternative. */
export function acceptAll(list: Suggestion[]): Suggestion[] {
  const takenGroups = new Set<string>();
  for (const s of list) if (s.group && s.accepted === true) takenGroups.add(s.group);
  return list.map((s) => {
    if (needsOwnDecision(s) || s.accepted !== null) return s;
    if (s.group) {
      if (takenGroups.has(s.group)) return s;
      takenGroups.add(s.group);
    }
    return { ...s, accepted: true };
  });
}

/** Reject everything, including key and version changes. */
export function rejectAll(list: Suggestion[]): Suggestion[] {
  return list.map((s) => (s.accepted === false ? s : { ...s, accepted: false }));
}

/** One explicit decision for every published-version change. */
export function setVersionChanges(list: Suggestion[], value: Decision): Suggestion[] {
  let out = list;
  for (const s of list) if (s.category === 'version') out = decide(out, s.id, value);
  return out;
}

/** Carry decisions over when suggestions are regenerated (e.g. settings changed). */
export function carryDecisions(prev: Suggestion[], next: Suggestion[]): Suggestion[] {
  const map = new Map(prev.filter((s) => s.accepted !== null).map((s) => [decisionKey(s), s.accepted]));
  return next.map((s) => (map.has(decisionKey(s)) ? { ...s, accepted: map.get(decisionKey(s))! } : s));
}

export interface ReviewCounts {
  total: number;
  accepted: number;
  rejected: number;
  undecided: number;
}

export function counts(list: Suggestion[]): ReviewCounts {
  const accepted = list.filter((s) => s.accepted === true).length;
  const rejected = list.filter((s) => s.accepted === false).length;
  return { total: list.length, accepted, rejected, undecided: list.length - accepted - rejected };
}

export type SectionId = 'conflict' | 'version' | 'missing' | 'url' | 'format' | 'key';

export const SECTIONS: { id: SectionId; title: string; blurb: string }[] = [
  { id: 'conflict', title: 'Corrections', blurb: 'Your entry disagrees with the matched record.' },
  { id: 'version', title: 'Published version', blurb: 'Changes that turn this preprint citation into a citation of the published paper.' },
  { id: 'missing', title: 'Missing information', blurb: 'Fields the matched record has and your entry does not.' },
  { id: 'url', title: 'Links', blurb: 'Problems with the URL.' },
  { id: 'format', title: 'Formatting', blurb: 'Presentation only. The metadata itself does not change.' },
  { id: 'key', title: 'Citation key', blurb: 'Renaming the key can break \\cite{} commands elsewhere in your project.' },
];

export function bySection(list: Suggestion[]) {
  return SECTIONS.map((sec) => ({ ...sec, items: list.filter((s) => s.category === sec.id) })).filter((sec) => sec.items.length > 0);
}
