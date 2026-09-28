import type { LookupResult } from '../core/models/types';
import { getJson } from '../core/net/http';
import { cached } from '../core/net/cache';

export interface DoiResolution {
  exists: boolean;
  /** Where doi.org would send a browser. */
  target?: string;
}

/**
 * Checks DOI resolution through the DOI handle API (doi.org/api/handles),
 * which reports whether the handle exists and its registered URL without
 * fetching the publisher page. responseCode 1 = found, 100 = not found.
 */
export async function resolveDoi(doi: string): Promise<LookupResult<DoiResolution>> {
  return cached<DoiResolution>(`doiresolve:${doi.toLowerCase()}`, async (): Promise<LookupResult<DoiResolution>> => {
    const r = await getJson<any>(`https://doi.org/api/handles/${encodeURIComponent(doi).replace(/%2F/gi, '/')}`, { passThrough: [404] });
    if (r.status !== 'OK') {
      return { status: r.status, detail: r.detail };
    }
    const code = r.value?.responseCode;
    if (code === 100) return { status: 'NO RECORD FOUND', value: { exists: false }, detail: 'doi.org does not know this DOI' };
    if (code !== 1) return { status: 'LOOKUP FAILED', detail: `doi.org responseCode ${code}` };
    const urlVal = (r.value.values ?? []).find((v: any) => v.type === 'URL');
    return { status: 'OK', value: { exists: true, target: urlVal?.data?.value } };
  });
}
