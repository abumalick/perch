import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from './csp';
import { buildHeadersFile, SECURITY_HEADERS } from './security-headers';

function parse(file: string): { path: string; headers: Record<string, string> } {
  const [path, ...lines] = file.trimEnd().split('\n');
  return {
    path: path!,
    headers: Object.fromEntries(lines.map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    })),
  };
}

describe('the _headers file', () => {
  it('applies to every path', () => {
    expect(parse(buildHeadersFile()).path).toBe('/*');
  });

  it('sends the same CSP as the meta tag, plus frame-ancestors, which only a header can carry', () => {
    const csp = parse(buildHeadersFile()).headers['Content-Security-Policy']!;
    expect(csp.startsWith(`${CONTENT_SECURITY_POLICY}; `)).toBe(true);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('refuses framing, sniffing, referrers and cross-origin openers', () => {
    expect(parse(buildHeadersFile()).headers).toMatchObject({
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
  });

  it('allows the app its own microphone, camera, clipboard, wake lock and share sheet, and turns off location', () => {
    const policy = SECURITY_HEADERS['Permissions-Policy']!.split(', ');
    for (const feature of ['microphone', 'camera', 'clipboard-read', 'clipboard-write', 'screen-wake-lock', 'web-share']) {
      expect(policy).toContain(`${feature}=(self)`);
    }
    expect(policy).toContain('geolocation=()');
  });

  it('keeps each header on one line', () => {
    for (const value of Object.values(SECURITY_HEADERS)) expect(value).not.toMatch(/[\r\n]/);
  });
});
