/**
 * QA pass: cache correctness and stored-settings validation. A cache must never
 * turn a stale or corrupt record into permanent truth, and settings loaded from
 * storage are untrusted input.
 */
import { cacheConfig, cached, clearCache, setKV, sha256 } from '../../core/net/cache';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../../ui/settings';
import { listEntries, filterChoices } from '../../ui/entries';
import { structuralChecks } from '../../core/verification/structural';
import { parseBibtex } from '../../core/parser/bibtex';
import type { LookupResult } from '../../core/models/types';

const store = new Map<string, unknown>();
beforeEach(() => {
  store.clear();
  cacheConfig.enabled = true;
  cacheConfig.successTtlMs = 30 * 24 * 3600 * 1000;
  cacheConfig.notFoundTtlMs = 24 * 3600 * 1000;
  setKV({
    get: async (k) => store.get(k),
    set: async (k, v) => void store.set(k, v),
    clear: async (p) => {
      for (const k of [...store.keys()]) if (k.startsWith(p)) store.delete(k);
    },
  });
});

const ok = (v: string): LookupResult<string> => ({ status: 'OK', value: v });

describe('cache', () => {
  it('serves a hit and skips the second lookup', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return ok('a');
    };
    expect((await cached('k1', fn)).value).toBe('a');
    const second = await cached('k1', fn);
    expect(second.value).toBe('a');
    expect(second.fromCache).toBe(true);
    expect(calls).toBe(1);
  });
  it('never caches failures', async () => {
    for (const status of ['LOOKUP FAILED', 'RATE LIMITED', 'NETWORK UNAVAILABLE'] as const) {
      let calls = 0;
      const fn = async (): Promise<LookupResult<string>> => {
        calls++;
        return { status };
      };
      await cached(`f-${status}`, fn);
      await cached(`f-${status}`, fn);
      expect(calls, status).toBe(2);
    }
  });
  it('caches "no record found" only for the shorter TTL', async () => {
    cacheConfig.notFoundTtlMs = 0;
    let calls = 0;
    const fn = async (): Promise<LookupResult<string>> => {
      calls++;
      return { status: 'NO RECORD FOUND' };
    };
    await cached('nf', fn);
    await cached('nf', fn);
    expect(calls).toBe(2); // expired immediately
  });
  it('expires by the stored TTL, not by the current config', async () => {
    await cached('exp', async () => ok('v'));
    const key = [...store.keys()][0];
    store.set(key, { ...(store.get(key) as object), at: Date.now() - 40 * 24 * 3600 * 1000 });
    let calls = 0;
    const fresh = await cached('exp', async () => {
      calls++;
      return ok('fresh');
    });
    expect(calls).toBe(1);
    expect(fresh.value).toBe('fresh');
  });
  it.each([null, 42, 'garbage', { at: 'soon', ttl: null }, { result: undefined }])('survives a corrupt cache entry %j', async (bad) => {
    store.set('cache:corrupt', bad);
    const r = await cached('corrupt', async () => ok('fresh'));
    expect(['fresh', undefined]).toContain(r.value);
    expect(r.status === 'OK' || r.status === 'LOOKUP FAILED').toBe(true);
  });
  it('survives a storage backend that throws', async () => {
    setKV({
      get: async () => {
        throw new Error('quota');
      },
      set: async () => {
        throw new Error('quota');
      },
      clear: async () => {},
    });
    await expect(cached('x', async () => ok('v'))).resolves.toMatchObject({ value: 'v' });
  });
  it('disabled cache always calls through', async () => {
    cacheConfig.enabled = false;
    let calls = 0;
    const fn = async () => {
      calls++;
      return ok('v');
    };
    await cached('d', fn);
    await cached('d', fn);
    expect(calls).toBe(2);
  });
  it('clearCache removes only cache keys', async () => {
    store.set('settings', { mode: 'clean' });
    await cached('c', async () => ok('v'));
    await clearCache();
    expect(store.has('settings')).toBe(true);
    expect([...store.keys()].some((k) => k.startsWith('cache:'))).toBe(false);
  });
  it('distinct queries hash to distinct keys', async () => {
    const a = await sha256('title=A&year=2020');
    const b = await sha256('title=A&year=2021');
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64);
    expect(await sha256('title=A&year=2020')).toBe(a);
  });
  it('two different publications cannot share a cache entry', async () => {
    await cached('crossref:doi:10.5555/a', async () => ok('paper A'));
    const b = await cached('crossref:doi:10.5555/b', async () => ok('paper B'));
    expect(b.value).toBe('paper B');
  });
});

describe('settings are validated on load', () => {
  it('falls back to defaults for garbage', () => {
    for (const bad of [null, undefined, 42, 'x', [], { mode: 'evil' }]) expect(sanitizeSettings(bad).mode).toBe('clean');
  });
  it('rejects an invalid contact e-mail rather than sending it', () => {
    expect(sanitizeSettings({ contactEmail: 'not-an-email' }).contactEmail).toBe('');
    expect(sanitizeSettings({ contactEmail: ' me@uni.edu ' }).contactEmail).toBe('me@uni.edu');
    expect(sanitizeSettings({ contactEmail: 'a@b.c\nX-Injected: 1' }).contactEmail).toBe('');
  });
  it('clamps TTLs and keeps a usable key scheme', () => {
    expect(sanitizeSettings({ successTtlDays: -5 }).successTtlDays).toBe(0);
    expect(sanitizeSettings({ successTtlDays: 1e9 }).successTtlDays).toBe(365);
    expect(sanitizeSettings({ keyScheme: { parts: ['evil'] } as never }).keyScheme.parts).toEqual(DEFAULT_SETTINGS.keyScheme.parts);
    expect(
      sanitizeSettings({ keyScheme: { parts: ['author', 'author', 'year'], separator: '%%', lowercase: 'yes' } as never }).keyScheme,
    ).toEqual({ parts: ['author', 'year'], separator: '_', lowercase: true });
  });
});

describe('.bib file handling', () => {
  const file = `% a comment
@string{acm = {ACM}}
@inproceedings{one, title={First Paper}, publisher=acm, year={2020}}
@article{broken, title={unclosed
@article{two, title={Second Paper}, year={2021}}
@misc{one, title={Duplicate key}, year={2022}}`;

  it('lists every parseable entry and reports the damaged one', () => {
    const l = listEntries(file);
    expect(l.choices.map((c) => c.key)).toEqual(['one', 'two', 'one']);
    expect(l.errorCount).toBeGreaterThan(0);
    expect(l.keys.size).toBe(2); // duplicate keys collapse in the key set
  });
  it('keeps each entry text separate so selecting one cannot alter another', () => {
    const l = listEntries(file);
    expect(l.choices[0].text).toContain('First Paper');
    expect(l.choices[0].text).not.toContain('Second Paper');
    expect(l.choices[1].text.startsWith('@article{two')).toBe(true);
  });
  it('exposes macros and other entries as context only', () => {
    const l = listEntries(file);
    expect(l.context.strings.has('acm')).toBe(true);
    expect(l.context.entries.length).toBe(3);
  });
  it('filters by key, title and year', () => {
    const l = listEntries(file);
    expect(filterChoices(l.choices, 'second').map((c) => c.key)).toEqual(['two']);
    expect(filterChoices(l.choices, '2021')).toHaveLength(1);
    expect(filterChoices(l.choices, '')).toHaveLength(3);
    expect(filterChoices(l.choices, 'nothing here')).toEqual([]);
  });
  it('handles a large file without hanging', () => {
    const big = Array.from(
      { length: 4000 },
      (_, i) => `@article{k${i}, title={Paper ${i}}, year={20${String(i % 100).padStart(2, '0')}}}`,
    ).join('\n\n');
    const started = Date.now();
    const l = listEntries(big);
    expect(l.choices.length).toBe(4000);
    expect(Date.now() - started).toBeLessThan(3000);
  });
  it('an empty or non-BibTeX file yields no entries rather than an error', () => {
    expect(listEntries('').choices).toEqual([]);
    expect(listEntries('just some prose about citations').choices).toEqual([]);
  });
});

describe('structural checks', () => {
  const check = (src: string) => {
    const p = parseBibtex(src);
    return structuralChecks(p.entries[0], p.errors, p.strings);
  };
  it('flags a missing citation key', () => {
    expect(check('@article{, title={T}}').some((c) => c.id === 'key' && c.state === 'CONFLICT')).toBe(true);
  });
  it('explains a citation key containing a space instead of failing on the next field', () => {
    const p = parseBibtex('@article{bad key, title={T}}');
    expect(p.entries).toEqual([]);
    expect(p.errors[0].message).toMatch(/Citation key .* cannot contain spaces/i);
    const r = structuralChecks(p.entries[0], p.errors, p.strings);
    expect(r[0]).toMatchObject({ id: 'parse', state: 'CONFLICT' });
    expect(r[0].detail).toMatch(/Citation key/);
  });
  it('flags a key with characters that break \\cite when the entry does parse', () => {
    expect(check('@article{key#with%chars, title={T}}').some((c) => c.id === 'key' && c.state === 'CONFLICT')).toBe(true);
  });
  it('flags duplicate fields without deleting either', () => {
    expect(check('@article{k, year={2020}, year={2021}}').some((c) => c.id === 'dups')).toBe(true);
  });
  it('reports missing required fields per type but not when crossref supplies them', () => {
    expect(check('@inproceedings{k, title={T}}').some((c) => c.id === 'required')).toBe(true);
    expect(check('@inproceedings{k, title={T}, crossref={proc}}').some((c) => c.id === 'required')).toBe(false);
  });
  it('flags undefined macros and unbalanced math', () => {
    expect(check('@article{k, journal=nosuchmacro, title={T}}').some((c) => c.id === 'macros')).toBe(true);
    expect(check('@article{k, title={Bounds on $O(n)}}').some((c) => c.id.startsWith('math-'))).toBe(true);
    expect(check('@article{k, title={Bounds on $O(n)$}}').some((c) => c.id.startsWith('math-'))).toBe(false);
  });
  it('flags an unknown entry type without refusing to work', () => {
    const r = check('@nonsense{k, title={T}}');
    expect(r.some((c) => c.id === 'type')).toBe(true);
    expect(r.some((c) => c.id === 'parse' && c.state !== 'CONFLICT')).toBe(true);
  });
});
