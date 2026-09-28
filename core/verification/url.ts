import type { Evidence, VerificationState } from '../models/types';
import { checkFetchableUrl } from '../security/url';
import { request } from '../net/http';
import { findDoiInText, parseDoi, sameDoi } from '../normalize/doi';
import { titleSimilarity } from '../normalize/text';
import { parseArxivId } from '../../sources/arxiv/adapter';

export interface UrlCheckResult {
  state: VerificationState;
  label: string;
  detail?: string;
  finalUrl?: string;
  redirected?: boolean;
  evidence: Evidence[];
}

export interface PageMetadata {
  title?: string;
  doi?: string;
}

/** Extracts scholarly metadata from HTML <meta> tags (Highwire/Dublin Core/OpenGraph). */
export function extractPageMetadata(html: string): PageMetadata {
  const head = html.slice(0, 600_000);
  const metas = new Map<string, string>();
  for (const m of head.matchAll(/<meta\s[^>]{0,2000}>/gi)) {
    const tag = m[0];
    const name = tag.match(/\b(?:name|property)\s*=\s*["']([^"']{1,100})["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/\bcontent\s*=\s*"([^"]{0,2000})"|\bcontent\s*=\s*'([^']{0,2000})'/i);
    if (name && content && !metas.has(name)) metas.set(name, decodeEntities(content[1] ?? content[2] ?? ''));
  }
  const titleTag = head.match(/<title[^>]*>([^<]{1,1000})<\/title>/i)?.[1];
  return {
    title:
      metas.get('citation_title') ?? metas.get('dc.title') ?? metas.get('og:title') ?? (titleTag ? decodeEntities(titleTag) : undefined),
    doi: parseDoi(metas.get('citation_doi') ?? metas.get('dc.identifier') ?? metas.get('prism.doi'))?.doi,
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** URLs we can verify without fetching the page (DOI links, arXiv abstracts). */
export function classifyUrl(url: string): { kind: 'doi'; doi: string } | { kind: 'arxiv'; id: string } | { kind: 'web' } {
  try {
    const u = new URL(url);
    if (/^(dx\.)?doi\.org$/i.test(u.hostname)) {
      const d = parseDoi(url);
      if (d) return { kind: 'doi', doi: d.doi };
    }
    if (/(^|\.)arxiv\.org$/i.test(u.hostname)) {
      const id = parseArxivId(url);
      if (id) return { kind: 'arxiv', id: id.replace(/v\d+$/, '') };
    }
  } catch {
    /* fallthrough */
  }
  return { kind: 'web' };
}

/**
 * Fetches a citation URL and checks it identifies the cited work.
 * HTTP 200 alone is never "VERIFIED". The caller must hold host permission.
 */
export async function checkUrl(url: string, cited: { title?: string; doi?: string }): Promise<UrlCheckResult> {
  const safe = checkFetchableUrl(url);
  if (!safe.ok) return { state: 'NOT CHECKED', label: 'URL not fetched', detail: safe.reason, evidence: [] };
  const r = await request(safe.url.toString(), { accept: 'text/html,application/xhtml+xml', timeoutMs: 10000, notFound: [404, 410] });
  if (r.status === 'NO RECORD FOUND')
    return { state: 'UNREACHABLE', label: 'URL unreachable', detail: `The page no longer exists (${r.detail}).`, evidence: [] };
  if (r.status === 'NETWORK UNAVAILABLE')
    return { state: 'NOT CHECKED', label: 'URL not checked', detail: 'You appear to be offline.', evidence: [] };
  if (r.status !== 'OK' || !r.value) {
    const http = /HTTP (\d{3})/.exec(r.detail ?? '');
    const code = http ? Number(http[1]) : 0;
    if (code === 401 || code === 403) {
      return {
        state: 'UNVERIFIED',
        label: 'URL blocks automated checks',
        detail: 'The site refused an automated request. Open it yourself to confirm.',
        evidence: [],
      };
    }
    if (code >= 500)
      return {
        state: 'UNREACHABLE',
        label: 'URL unreachable',
        detail: `The server returned an error (${r.detail}). It may be temporary.`,
        evidence: [],
      };
    // Timeouts, DNS failures and cross-origin redirects all surface as a generic
    // failure. None of them proves the URL is dead, so it stays NOT CHECKED (Rule 13).
    return {
      state: 'NOT CHECKED',
      label: 'URL could not be checked',
      detail: `${r.detail ?? 'The request failed'}. The site may be down, slow, or redirect to a domain BibCleaner has not been allowed to contact.`,
      evidence: [],
    };
  }
  const final = r.value.finalUrl;
  const finalSafe = checkFetchableUrl(final);
  if (!finalSafe.ok)
    return { state: 'CONFLICT', label: 'URL redirects somewhere unsafe', detail: finalSafe.reason, finalUrl: final, evidence: [] };
  const redirectNote = r.value.redirected && final !== url ? ` Redirects to ${final}.` : '';
  if (!/html|xml/i.test(r.value.contentType)) {
    return {
      state: 'UNVERIFIED',
      label: 'URL reachable',
      detail: `Reachable (${r.value.contentType || 'unknown type'}), but the page does not identify the work.${redirectNote}`,
      finalUrl: final,
      redirected: r.value.redirected,
      evidence: [],
    };
  }
  const meta = extractPageMetadata(r.value.body);
  const doiInPage = meta.doi ?? findDoiInText(final) ?? undefined;
  const ev: Evidence[] = [{ source: 'URL', value: meta.title ?? '(no title found)', recordUrl: final }];
  if (cited.doi && doiInPage) {
    if (sameDoi(cited.doi, doiInPage))
      return {
        state: 'VERIFIED',
        label: 'URL verified',
        detail: `The page declares the same DOI.${redirectNote}`,
        finalUrl: final,
        redirected: r.value.redirected,
        evidence: ev,
      };
    return {
      state: 'CONFLICT',
      label: 'URL points to a different DOI',
      detail: `The page declares DOI ${doiInPage}.${redirectNote}`,
      finalUrl: final,
      redirected: r.value.redirected,
      evidence: ev,
    };
  }
  if (cited.title && meta.title) {
    const sim = titleSimilarity(cited.title, meta.title);
    if (sim >= 0.9)
      return {
        state: 'HIGH CONFIDENCE',
        label: 'URL likely correct',
        detail: `The page title matches.${redirectNote}`,
        finalUrl: final,
        redirected: r.value.redirected,
        evidence: ev,
      };
    if (sim < 0.4 && meta.title.length > 25)
      return {
        state: 'CONFLICT',
        label: 'URL may point to a different work',
        detail: `The page title is "${meta.title}".${redirectNote}`,
        finalUrl: final,
        redirected: r.value.redirected,
        evidence: ev,
      };
  }
  return {
    state: 'UNVERIFIED',
    label: 'URL reachable',
    detail: `Reachable, but there is not enough metadata to confirm it is this work.${redirectNote}`,
    finalUrl: final,
    redirected: r.value.redirected,
    evidence: ev,
  };
}
