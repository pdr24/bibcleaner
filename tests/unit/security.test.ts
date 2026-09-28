import { checkFetchableUrl } from '../../core/security/url';

describe('URL safety', () => {
  it.each([
    'http://localhost/x',
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.20.0.1/',
    'http://169.254.169.254/latest',
    'http://[::1]/',
    'http://2130706433/',
    'http://0x7f000001/',
    'file:///etc/passwd',
    'chrome://settings',
    'chrome-extension://abc/x',
    'javascript:alert(1)',
    'https://user:pw@example.com/',
    'http://router.local/',
    'http://intranet/',
    'https://example.com:22/',
  ])('rejects %s', (u) => expect(checkFetchableUrl(u).ok).toBe(false));
  it.each(['https://dl.acm.org/doi/10.1145/1', 'http://example.com/paper.pdf', 'https://arxiv.org/abs/2401.00001'])('allows %s', (u) =>
    expect(checkFetchableUrl(u).ok).toBe(true),
  );
});
