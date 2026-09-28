/** QA pass: SSRF-style URL abuse, DOI normalisation edge cases. */
import { checkFetchableUrl } from '../../core/security/url';
import { doiUrl, findDoiInText, isArxivDoi, parseDoi, sameDoi } from '../../core/normalize/doi';

describe('URL safety: schemes and credentials', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:x',
    'ftp://example.com/x',
    'file://localhost/etc/passwd',
    'chrome://version',
    'chrome-extension://abcdefghijklmnop/popup.html',
    'blob:https://example.com/uuid',
    'about:blank',
    'ws://example.com/',
    'mailto:a@b.com',
    '//example.com/protocol-relative',
    'example.com/no-scheme',
    '',
    '   ',
    'https://',
    'http://:80/',
    'https://user@example.com/',
    'https://user:pass@example.com/',
  ])('rejects %j', (u) => expect(checkFetchableUrl(u).ok).toBe(false));
});

describe('URL safety: local and reserved addresses', () => {
  it.each([
    'http://127.0.0.1:8080/',
    'http://127.1.2.3/',
    'http://0.0.0.0/',
    'http://[::1]:443/',
    'http://[::]/',
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://10.255.255.254/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.0.1/',
    'http://198.18.0.1/',
    'http://224.0.0.1/',
    'http://255.255.255.255/',
    'http://2130706433/',
    'http://0x7f.0x0.0x0.0x1/',
    'http://017700000001/',
    'http://localhost.',
    'http://foo.localhost/',
    'http://printer.local/',
    'http://db.internal/',
    'http://nas.lan/',
    'http://x.home.arpa/',
    'http://intranet/',
    'https://example.com:22/',
    'https://example.com:3306/',
  ])('rejects %s', (u) => expect(checkFetchableUrl(u).ok).toBe(false));

  it.each([
    'https://dl.acm.org/doi/10.1145/3313831.3376234',
    'https://ieeexplore.ieee.org/document/1234567',
    'http://link.springer.com/chapter/10.1007/x',
    'https://arxiv.org/abs/2401.00001',
    'https://doi.org/10.1145/1',
    'https://example.co.uk:8443/p',
    'https://sub.domain.example.org/a/b?c=d#e',
    'https://8.8.8.8/public',
  ])('allows %s', (u) => expect(checkFetchableUrl(u).ok).toBe(true));

  it('normalises nothing about the user citation: the check is read-only', () => {
    const raw = 'https://Example.COM/Paper?q=A%20B';
    const r = checkFetchableUrl(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.pathname).toBe('/Paper');
  });
});

describe('DOI normalisation', () => {
  const forms = [
    '10.1145/1234567.1234568',
    'doi:10.1145/1234567.1234568',
    'DOI: 10.1145/1234567.1234568',
    'https://doi.org/10.1145/1234567.1234568',
    'http://doi.org/10.1145/1234567.1234568',
    'http://dx.doi.org/10.1145/1234567.1234568',
    'https://dx.doi.org/10.1145/1234567.1234568',
    'https://www.doi.org/10.1145/1234567.1234568',
    ' 10.1145/1234567.1234568 ',
    '10.1145/1234567.1234568.',
    '{10.1145/1234567.1234568}',
    '10.1145/1234567.1234568,',
  ];
  it.each(forms)('recognises %j', (f) => expect(parseDoi(f)?.doi).toBe('10.1145/1234567.1234568'));

  it('treats DOIs as case-insensitive for comparison but keeps the written case', () => {
    expect(sameDoi('10.1145/ABC.def', '10.1145/abc.DEF')).toBe(true);
    expect(parseDoi('10.1145/ABC.def')!.doi).toBe('10.1145/ABC.def');
  });
  it('accepts unusual but legal characters', () => {
    for (const d of [
      '10.1000/182',
      '10.1002/(SICI)1097-0258(19980815)17:15<1661::AID-SIM968>3.0.CO;2-2',
      '10.5555/a_b-c+d~e',
      '10.48550/arXiv.2401.00001',
    ]) {
      expect(parseDoi(d), d).not.toBeNull();
    }
  });
  it('unescapes LaTeX escapes and percent encoding', () => {
    expect(parseDoi('10.1000/abc\\_def')?.doi).toBe('10.1000/abc_def');
    expect(parseDoi('https://doi.org/10.1000%2Fabc')?.doi).toBe('10.1000/abc');
  });
  it.each(['', '  ', 'not a doi', '10.12/x', '11.1145/x', '10.1145/', 'doi:', 'https://doi.org/', '10.1145 /x', undefined])(
    'rejects %j',
    (d) => {
      expect(parseDoi(d as string | undefined)).toBeNull();
    },
  );
  it('rejects absurdly long DOIs', () => expect(parseDoi('10.1145/' + 'a'.repeat(400))).toBeNull());
  it('finds a DOI inside free text and urls', () => {
    expect(findDoiInText('see https://dl.acm.org/doi/10.1145/3313831.3376234 for more')).toBe('10.1145/3313831.3376234');
    expect(findDoiInText('no identifier here')).toBeNull();
  });
  it('builds a safe doi.org link', () => {
    expect(doiUrl('10.1145/a b')).toBe('https://doi.org/10.1145/a%20b');
    expect(checkFetchableUrl(doiUrl('10.1145/1234567.1234568')).ok).toBe(true);
  });
  it('identifies arXiv DOIs case-insensitively', () => {
    expect(isArxivDoi('10.48550/ARXIV.2401.00001')).toBe(true);
    expect(isArxivDoi('10.1145/1')).toBe(false);
  });
  it('is idempotent', () => {
    const once = parseDoi('https://doi.org/10.1145/X.y')!.doi;
    expect(parseDoi(once)!.doi).toBe(once);
  });
});
