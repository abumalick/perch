import { describe, expect, it } from 'vitest';
import { generatePairingSecret, isPairingPath, pairingLink, parsePairingLink } from './pairing-link';

const pairing = {
  url: 'wss://relay.example/abcDEF_123-xyz',
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

  it('keeps the relay URL readable, and a name with spaces or & intact', () => {
    const link = pairingLink('https://pwa.example', { ...pairing, name: 'a & b=c' });
    expect(link).toContain('u=wss://relay.example/abcDEF_123-xyz&');
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
      variants((q) => q.set('u', 'https://relay.example/acct')),
      variants((q) => q.set('u', 'ws://relay.example/acct')),
      variants((q) => q.set('u', 'wss://relay.example/')),
      variants((q) => q.set('u', 'wss://relay.example/a/b')),
      variants((q) => q.set('u', 'wss://relay.example/acct?role=agent')),
      variants((q) => q.set('n', 'x'.repeat(65))),
    ]) {
      expect(parsePairingLink(bad)).toBe(null);
    }
  });

  // Plain ws: would carry the upgrade (the device's signature and enrolment proof) in the clear; it
  // is kept only for a relay on the phone's own machine, which is what the e2e and a local test use.
  it('takes a plain ws: relay only on a loopback address', () => {
    for (const host of ['127.0.0.1:8450', 'localhost:8450', '[::1]:8450']) {
      expect(parsePairingLink(pairingLink('https://pwa.example', { ...pairing, url: `ws://${host}/acct` }))?.url).toBe(`ws://${host}/acct`);
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
