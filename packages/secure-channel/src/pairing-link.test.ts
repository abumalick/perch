import { describe, expect, it } from 'vitest';
import { generatePairingSecret, isMachineUrl, isPairingPath, MAX_ADDRESSES, pairingLink, parsePairingLink } from './pairing-link';

const pairing = {
  urls: ['wss://box.example/abcDEF_123-xyz'],
  agentKey: 'A'.repeat(43),
  secret: generatePairingSecret(),
  name: 'dev box',
};

describe('pairing link', () => {
  it('puts everything in the fragment, which a browser never sends to a server', () => {
    const link = pairingLink('https://pwa.example:8443', pairing);
    const parsed = new URL(link);
    expect(parsed.origin).toBe('https://pwa.example:8443');
    expect(parsed.pathname).toBe('/');
    expect(parsed.search).toBe('');
    expect(parsed.hash.startsWith('#pair?')).toBe(true);
    expect(link.split('#')[0]).not.toContain(pairing.secret);
  });

  it('round-trips, from the link or from its fragment alone', () => {
    const link = pairingLink('https://pwa.example', pairing);
    expect(parsePairingLink(link)).toEqual(pairing);
    expect(parsePairingLink(new URL(link).hash)).toEqual(pairing);
    expect(parsePairingLink(`  ${link}\n`)).toEqual(pairing);
  });

  it('keeps the address readable, and a name with spaces or & intact', () => {
    const link = pairingLink('https://pwa.example', { ...pairing, name: 'a & b=c' });
    expect(link).toContain('u=wss://box.example/abcDEF_123-xyz&');
    expect(parsePairingLink(link)!.name).toBe('a & b=c');
  });

  it('ignores a trailing path on the origin', () => {
    expect(new URL(pairingLink('https://pwa.example/', pairing)).pathname).toBe('/');
  });

  it('refuses anything that is not a complete pairing link', () => {
    const good = new URL(pairingLink('https://pwa.example', pairing));
    const variants = (change: (q: URLSearchParams) => void) => {
      const q = new URLSearchParams(good.hash.slice('#pair?'.length));
      change(q);
      return `https://pwa.example/#pair?${q}`;
    };
    for (const bad of [
      '',
      'https://pwa.example/',
      'https://pwa.example/#other?u=x',
      variants((q) => q.delete('s')),
      variants((q) => q.set('k', 'short')),
      variants((q) => q.set('s', 'short')),
      variants((q) => q.set('u', 'https://box.example/acct')),
      variants((q) => q.set('u', 'ws://box.example/acct')),
      variants((q) => q.set('u', 'wss://box.example/a/b')),
      variants((q) => q.set('u', 'wss://box.example/acct?role=agent')),
      variants((q) => q.set('n', 'x'.repeat(65))),
    ]) {
      expect(parsePairingLink(bad)).toBe(null);
    }
  });

  // Plain ws: would carry the upgrade (the device's signature and enrolment proof) in the clear; it
  // is kept only for a machine on the phone's own host, which is what the e2e and a local test use.
  it('takes a plain ws: address only on a loopback address', () => {
    for (const host of ['127.0.0.1:8450', 'localhost:8450', '[::1]:8450']) {
      expect(parsePairingLink(pairingLink('https://pwa.example', { ...pairing, urls: [`ws://${host}/acct`] }))?.urls).toEqual([`ws://${host}/acct`]);
    }
  });

  it('names the machine "machine" when the link carries no name', () => {
    const q = new URLSearchParams(new URL(pairingLink('https://pwa.example', pairing)).hash.slice('#pair?'.length));
    q.delete('n');
    expect(parsePairingLink(`#pair?${q}`)?.name).toBe('machine');
  });

  it("carries the machine's default path when it has one, readable", () => {
    const link = pairingLink('https://pwa.example', { ...pairing, defaultPath: '/home/u/my workspace' });
    expect(link).toContain('&p=/home/u/my%20workspace');
    expect(parsePairingLink(link)).toEqual({ ...pairing, defaultPath: '/home/u/my workspace' });
  });

  it('adds no p= without a default path', () => {
    expect(pairingLink('https://pwa.example', pairing)).not.toContain('&p=');
  });

  // The path is a convenience: one the phone cannot use costs the path, not the pairing.
  it('drops a default path that is not absolute or is too long, and keeps the rest of the link', () => {
    for (const defaultPath of ['~/workspace', 'workspace', '/' + 'x'.repeat(128), '/a\nb']) {
      expect(parsePairingLink(pairingLink('https://pwa.example', { ...pairing, defaultPath }))).toEqual(pairing);
    }
  });

  it('takes an absolute default path up to 128 characters', () => {
    expect(isPairingPath('/' + 'x'.repeat(127))).toBe(true);
    expect(isPairingPath('/' + 'x'.repeat(128))).toBe(false);
    expect(isPairingPath('~/workspace')).toBe(false);
  });
});

// The vector the agent's `perch setup` and the PWA are both held to.
describe('pairing link with several addresses', () => {
  const agentKey = 'K'.repeat(43);
  const secret = 'S'.repeat(43);
  const vector =
    `https://tarfa.app/#pair?u=wss://dev.example.ts.net:10000/abu&u=wss://dev.example.ts.net:8443/abu&k=${agentKey}&s=${secret}&n=dev&p=/home/u/workspace`;

  it('reads every address, in order', () => {
    expect(parsePairingLink(vector)).toEqual({
      urls: ['wss://dev.example.ts.net:10000/abu', 'wss://dev.example.ts.net:8443/abu'],
      agentKey,
      secret,
      name: 'dev',
      defaultPath: '/home/u/workspace',
    });
  });

  it(`refuses more than ${MAX_ADDRESSES} addresses`, () => {
    const urls = Array.from({ length: MAX_ADDRESSES + 1 }, (_, i) => `wss://h${i}.example/x`);
    const link = pairingLink('https://tarfa.app', { ...pairing, urls: urls.slice(0, MAX_ADDRESSES) });
    expect(parsePairingLink(link)?.urls).toEqual(urls.slice(0, MAX_ADDRESSES));
    expect(parsePairingLink(link.replace('&k=', `&u=${urls[MAX_ADDRESSES]}&k=`))).toBe(null);
  });

  it('refuses the whole link when one address is bad', () => {
    expect(parsePairingLink(vector.replace('u=wss://dev.example.ts.net:8443/abu', 'u=https://dev.example.ts.net:8443/abu'))).toBe(null);
    expect(parsePairingLink(vector.replace('u=wss://dev.example.ts.net:8443/abu', 'u='))).toBe(null);
  });

  it('round-trips one and three addresses in order', () => {
    for (const urls of [['wss://a.example/'], ['wss://c.example:10000/abu', 'wss://a.example/', 'wss://b.example:8443/x-1']]) {
      expect(parsePairingLink(pairingLink('https://tarfa.app', { ...pairing, urls }))?.urls).toEqual(urls);
    }
  });

  it('takes a bare / path or one segment, nothing deeper', () => {
    expect(isMachineUrl('wss://dev.example.ts.net:10000')).toBe(true);
    expect(isMachineUrl('wss://dev.example.ts.net:10000/')).toBe(true);
    expect(isMachineUrl('wss://dev.example.ts.net/abu')).toBe(true);
    expect(isMachineUrl('wss://dev.example.ts.net/a/b')).toBe(false);
    expect(isMachineUrl(`wss://dev.example.ts.net/${'x'.repeat(65)}`)).toBe(false);
    expect(isMachineUrl('ws://dev.example.ts.net/abu')).toBe(false);
  });

  it('refuses a link with no address', () => {
    expect(parsePairingLink(vector.replace(/u=[^&]*&/g, ''))).toBe(null);
  });
});
