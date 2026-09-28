/**
 * Local cache for PUBLIC scholarly metadata only. Keys are identifiers or
 * SHA-256 hashes of normalised queries; no record of which citation the
 * user worked on is kept beyond what the lookup itself requires.
 */
import type { LookupResult } from '../models/types';

export interface KV {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  clear(prefix: string): Promise<void>;
}

class MemoryKV implements KV {
  private m = new Map<string, unknown>();
  async get(k: string) {
    return this.m.get(k);
  }
  async set(k: string, v: unknown) {
    this.m.set(k, v);
  }
  async clear(prefix: string) {
    for (const k of [...this.m.keys()]) if (k.startsWith(prefix)) this.m.delete(k);
  }
}

declare const chrome: any;

class ChromeKV implements KV {
  async get(k: string) {
    const r = await chrome.storage.local.get(k);
    return r[k];
  }
  async set(k: string, v: unknown) {
    await chrome.storage.local.set({ [k]: v });
  }
  async clear(prefix: string) {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(prefix));
    if (keys.length) await chrome.storage.local.remove(keys);
  }
}

const PREFIX = 'cache:';

export const cacheConfig = {
  enabled: true,
  successTtlMs: 30 * 24 * 3600 * 1000,
  notFoundTtlMs: 24 * 3600 * 1000,
};

let kv: KV = typeof chrome !== 'undefined' && chrome?.storage?.local ? new ChromeKV() : new MemoryKV();

export function setKV(impl: KV): void {
  kv = impl;
}

export async function sha256(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Stored<T> {
  at: number;
  ttl: number;
  result: LookupResult<T>;
}

/** Caches OK results (30 d) and NO RECORD FOUND (24 h). Failures are never cached. */
export async function cached<T>(key: string, fn: () => Promise<LookupResult<T>>): Promise<LookupResult<T> & { fromCache?: boolean }> {
  const full = PREFIX + key;
  if (cacheConfig.enabled) {
    try {
      const hit = (await kv.get(full)) as Stored<T> | undefined;
      if (hit && Date.now() - hit.at < hit.ttl) return { ...hit.result, fromCache: true };
    } catch {
      /* cache is best-effort */
    }
  }
  const result = await fn();
  if (cacheConfig.enabled && (result.status === 'OK' || result.status === 'NO RECORD FOUND')) {
    const ttl = result.status === 'OK' ? cacheConfig.successTtlMs : cacheConfig.notFoundTtlMs;
    try {
      await kv.set(full, { at: Date.now(), ttl, result } satisfies Stored<T>);
    } catch {
      /* quota etc. */
    }
  }
  return result;
}

export async function clearCache(): Promise<void> {
  await kv.clear(PREFIX);
}
