import type { KeyScheme } from '../core/formatter/citekey';
import { DEFAULT_KEY_SCHEME } from '../core/formatter/citekey';
import type { AuthorFormat } from '../core/normalize/authors';
import type { Mode } from '../core/verification/evaluate';
import { cacheConfig } from '../core/net/cache';
import { sourceSettings } from '../sources/types';
import { storageGet, storageSet } from './platform';

export interface Settings {
  mode: Mode;
  authorFormat: AuthorFormat;
  keyScheme: KeyScheme;
  latexAccents: boolean;
  /** Optional, sent only to Crossref and OpenAlex to join their "polite" pools. */
  contactEmail: string;
  cacheEnabled: boolean;
  successTtlDays: number;
  notFoundTtlHours: number;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'clean',
  authorFormat: 'last-first',
  keyScheme: DEFAULT_KEY_SCHEME,
  latexAccents: true,
  contactEmail: '',
  cacheEnabled: true,
  successTtlDays: 30,
  notFoundTtlHours: 24,
};

const KEY = 'settings';
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/** Validates everything loaded from storage; bad values fall back to defaults. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  const num = (v: unknown, d: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
  const ks = (r.keyScheme ?? {}) as Partial<KeyScheme>;
  const partsOk =
    Array.isArray(ks.parts) && ks.parts.length > 0 && ks.parts.every((p) => ['author', 'year', 'keyword', 'venue'].includes(p));
  return {
    mode: r.mode === 'verify' ? 'verify' : 'clean',
    authorFormat: r.authorFormat === 'first-last' ? 'first-last' : 'last-first',
    keyScheme: {
      parts: partsOk ? [...new Set(ks.parts!)] : DEFAULT_KEY_SCHEME.parts,
      separator: typeof ks.separator === 'string' && /^[_:\-.]?$/.test(ks.separator) ? ks.separator : DEFAULT_KEY_SCHEME.separator,
      lowercase: typeof ks.lowercase === 'boolean' ? ks.lowercase : true,
    },
    latexAccents: typeof r.latexAccents === 'boolean' ? r.latexAccents : true,
    contactEmail: typeof r.contactEmail === 'string' && EMAIL.test(r.contactEmail.trim()) ? r.contactEmail.trim() : '',
    cacheEnabled: typeof r.cacheEnabled === 'boolean' ? r.cacheEnabled : true,
    successTtlDays: num(r.successTtlDays, 30, 0, 365),
    notFoundTtlHours: num(r.notFoundTtlHours, 24, 0, 24 * 30),
  };
}

/** Pushes settings into the core modules that read them. */
export function applySettings(s: Settings): void {
  sourceSettings.contactEmail = s.contactEmail || undefined;
  cacheConfig.enabled = s.cacheEnabled;
  cacheConfig.successTtlMs = s.successTtlDays * 24 * 3600 * 1000;
  cacheConfig.notFoundTtlMs = s.notFoundTtlHours * 3600 * 1000;
}

export async function loadSettings(): Promise<Settings> {
  const s = sanitizeSettings(await storageGet(KEY));
  applySettings(s);
  return s;
}

export async function saveSettings(s: Settings): Promise<void> {
  applySettings(s);
  await storageSet(KEY, s);
}
