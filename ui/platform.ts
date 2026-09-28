/**
 * Thin wrappers over the Chrome APIs the UI needs, with in-memory fallbacks
 * so the UI can also run in a plain browser tab during development.
 * Only `storage` and (optional, on-demand) host permissions are used.
 */
const hasChrome = () => typeof chrome !== 'undefined' && !!chrome.storage?.local;
const mem = new Map<string, unknown>();

export async function storageGet(key: string): Promise<unknown> {
  if (!hasChrome()) return mem.get(key);
  return (await chrome.storage.local.get(key))[key];
}

export async function storageSet(key: string, value: unknown): Promise<void> {
  if (!hasChrome()) return void mem.set(key, value);
  await chrome.storage.local.set({ [key]: value });
}

export const PENDING_KEY = 'pendingSelection';

/**
 * Text handed over by the context menu. It lives in session storage (memory
 * only, cleared when the browser closes) and is removed as soon as it is read,
 * so no history of selections accumulates.
 */
export async function takePendingSelection(): Promise<string | undefined> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return undefined;
  const r = await chrome.storage.session.get(PENDING_KEY);
  const v = r[PENDING_KEY] as { text?: unknown; at?: unknown } | undefined;
  await chrome.storage.session.remove(PENDING_KEY);
  if (!v || typeof v.text !== 'string') return undefined;
  // Ignore stale hand-overs (e.g. the tab was never opened).
  if (typeof v.at === 'number' && Date.now() - v.at > 5 * 60 * 1000) return undefined;
  return v.text;
}

export const isPopup = (): boolean => new URLSearchParams(location.search).get('view') !== 'tab';

export function openInTab(extra = ''): void {
  const url = `${location.pathname}?view=tab${extra}`;
  if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
    void chrome.tabs.create({ url: chrome.runtime.getURL(url.replace(/^\//, '')) });
    window.close();
  } else window.open(url, '_blank', 'noopener');
}

/** Host permission for checking one citation URL, requested only when the user asks. */
export async function requestUrlPermission(url: string, allSites = false): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.permissions) return true;
  const u = new URL(url);
  const origins = allSites ? ['http://*/*', 'https://*/*'] : [`${u.protocol}//${u.hostname}/*`];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

export async function hasAllSitesPermission(): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.permissions) return false;
  return chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
}

export async function removeAllSitesPermission(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.permissions) return;
  await chrome.permissions.remove({ origins: ['http://*/*', 'https://*/*'] });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** Saves locally through a blob link; no "downloads" permission needed. */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text.endsWith('\n') ? text : text + '\n'], { type: 'application/x-bibtex;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function safeFilename(key: string | undefined): string {
  const base = (key ?? 'entry').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'entry';
  return `${base}.bib`;
}
