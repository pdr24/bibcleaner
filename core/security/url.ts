/**
 * URL safety checks applied before BibCleaner fetches any URL taken from a
 * citation. Designed with SSRF-style abuse in mind: a hostile .bib file must
 * not be able to make the extension probe the user's local network.
 *
 * Limitation: a browser extension cannot resolve DNS itself, so a public
 * hostname that resolves to a private address cannot be detected before the
 * request. The final (post-redirect) URL is re-checked after the request.
 */

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

function ipv4Private(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function looksNumericHost(host: string): boolean {
  // Decimal / hex / octal integer hosts ("2130706433", "0x7f000001") are rejected outright.
  return /^(0x[0-9a-f]+|\d+)$/i.test(host) || (/^[0-9a-fx.]+$/i.test(host) && !/^(\d{1,3}\.){3}\d{1,3}$/.test(host) && /\d/.test(host));
}

export function checkFetchableUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'Not a valid absolute URL.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: `The ${url.protocol} scheme is not allowed.` };
  if (url.username || url.password) return { ok: false, reason: 'URLs containing credentials are not fetched.' };
  // Trailing dots make a name fully qualified ("localhost." === "localhost"),
  // so they are stripped before any host comparison.
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (!host) return { ok: false, reason: 'URL has no host.' };
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa')
  )
    return { ok: false, reason: 'Local network addresses are not fetched.' };
  if (!host.includes('.') && !host.includes(':')) return { ok: false, reason: 'Single-label hostnames are not fetched.' };
  if (ipv4Private(host)) return { ok: false, reason: 'Private or reserved IP addresses are not fetched.' };
  if (host.includes(':')) {
    // IPv6 literal: allow only global unicast, reject loopback/link-local/ULA/mapped.
    if (host === '::1' || host === '::' || /^(fe8|fe9|fea|feb|fc|fd)/i.test(host) || /^::ffff:/i.test(host))
      return { ok: false, reason: 'Private or reserved IPv6 addresses are not fetched.' };
  }
  if (looksNumericHost(host)) return { ok: false, reason: 'Numeric host encodings are not fetched.' };
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) return { ok: false, reason: `Port ${url.port} is not fetched.` };
  return { ok: true, url };
}
