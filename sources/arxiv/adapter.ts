import type { LookupResult, Work } from '../../core/models/types';
import { request } from '../../core/net/http';
import { cached } from '../../core/net/cache';
import { parseDoi } from '../../core/normalize/doi';
import { splitDisplayName, yearFrom } from '../types';

const BASE = 'https://export.arxiv.org/api/query';

/** Normalises "arXiv:2401.12345v2", "https://arxiv.org/abs/2401.12345" or "cs/0112017" to an id. */
export function parseArxivId(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw
    .trim()
    .replace(/^arxiv:\s*/i, '')
    .replace(/^(https?:\/\/)?(www\.|export\.)?arxiv\.org\/(abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '');
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(s)) return s;
  if (/^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/.test(s)) return s;
  return null;
}

function tag(xml: string, name: string): string | undefined {
  const open = `<${name}`;
  const i = xml.indexOf(open);
  if (i < 0) return undefined;
  const gt = xml.indexOf('>', i);
  const close = xml.indexOf(`</${name}>`, gt);
  if (gt < 0 || close < 0) return undefined;
  return decode(xml.slice(gt + 1, close).trim());
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

export function mapArxivAtom(xml: string): Work | null {
  const start = xml.indexOf('<entry>');
  if (start < 0) return null;
  const entry = xml.slice(start, xml.indexOf('</entry>', start));
  const idUrl = tag(entry, 'id') ?? '';
  const id = parseArxivId(idUrl);
  const title = tag(entry, 'title');
  if (!id || !title || /^Error$/i.test(title)) return null;
  const authors = [...entry.matchAll(/<author>\s*<name>([^<]{1,300})<\/name>/g)].map((m) => splitDisplayName(decode(m[1])));
  const publishedDoi = parseDoi(tag(entry, 'arxiv:doi'))?.doi;
  const bare = id.replace(/v\d+$/, '');
  return {
    title,
    authors,
    year: yearFrom(tag(entry, 'published')),
    venue: 'arXiv',
    doi: `10.48550/arXiv.${bare}`,
    url: `https://arxiv.org/abs/${bare}`,
    arxivId: bare,
    type: 'preprint',
    isPreprint: true,
    relatedDois: publishedDoi ? [publishedDoi] : [],
    sourceRecords: [{ source: 'arXiv', recordUrl: `https://arxiv.org/abs/${bare}`, nativeId: bare, retrievedAt: Date.now() }],
  };
}

export class ArxivAdapter {
  readonly name = 'arXiv' as const;
  async lookupById(id: string): Promise<LookupResult<Work>> {
    const bare = id.replace(/v\d+$/, '');
    const r = await cached(`arxiv:id:${bare}`, async () => {
      const res = await request(`${BASE}?${new URLSearchParams({ id_list: bare, max_results: '1' })}`, {
        accept: 'application/atom+xml',
        timeoutMs: 10000,
      });
      if (res.status !== 'OK' || !res.value) return { status: res.status, detail: res.detail };
      const w = mapArxivAtom(res.value.body);
      return w ? { status: 'OK' as const, value: w } : { status: 'NO RECORD FOUND' as const };
    });
    return r;
  }
}
