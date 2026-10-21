import { describe, expect, it } from 'vitest';
import { pairingLink, type PairingLink } from '@perch/secure-channel';
import { deviceFingerprint } from '@perch/secure-channel';
import { acceptPairingLink, outsideInstalledApp, pairedMachine, pairingQuestion, readPairingLink, takePairingFragment } from './pairing';
import type { MachineConfig } from './settings-store';

const link: PairingLink = {
  url: 'wss://relay.example/acct123',
  agentKey: 'K'.repeat(43),
  secret: 'S'.repeat(43),
  name: 'dev',
};

describe('pairedMachine', () => {
  it('adds a relay entry named after the machine, carrying the one-time secret and no token', () => {
    expect(pairedMachine([], link, () => 'id1')).toEqual({ ok: true, machine: {
      id: 'id1',
      name: 'dev',
      url: link.url,
      token: '',
      agentKey: link.agentKey,
      pairing: link.secret,
    } });
  });

  it('updates the entry for the same relay and agent key instead of adding a second one', () => {
    const existing: MachineConfig = { id: 'm1', name: 'dev (relay)', url: link.url, token: 'tok', agentKey: link.agentKey, enabled: false };
    expect(pairedMachine([existing], link, () => 'unused')).toEqual({ ok: true, machine: { ...existing, pairing: link.secret, enabled: true } });
  });

  it("takes the machine's default path on a new entry", () => {
    const paired = pairedMachine([], { ...link, defaultPath: '/home/u/workspace' }, () => 'id1');
    expect(paired.ok && paired.machine.defaultPath).toBe('/home/u/workspace');
  });

  // A re-scan retries a pairing; the path the owner set in Settings is theirs, like the name.
  it("fills an existing entry's default path only when it has none", () => {
    const existing: MachineConfig = { id: 'm1', name: 'dev', url: link.url, token: '', agentKey: link.agentKey };
    const withPath = { ...link, defaultPath: '/home/u/workspace' };
    const filled = pairedMachine([existing], withPath, () => 'unused');
    expect(filled.ok && filled.machine.defaultPath).toBe('/home/u/workspace');
    const kept = pairedMachine([{ ...existing, defaultPath: '/srv/mine' }], withPath, () => 'unused');
    expect(kept.ok && kept.machine.defaultPath).toBe('/srv/mine');
  });

  it('refuses a code that would re-pin an entry to another agent key, which could take its token', () => {
    const existing: MachineConfig = { id: 'm1', name: 'dev', url: link.url, token: 'tok', agentKey: 'A'.repeat(43) };
    const result = pairedMachine([existing], link, () => 'unused');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/another key for dev/);
  });
});

describe('acceptPairingLink', () => {
  function prompts(answer: boolean) {
    const asked: string[] = [];
    const alerts: string[] = [];
    return {
      asked,
      alerts,
      confirm: (question: string) => (asked.push(question), answer),
      alert: (message: string) => void alerts.push(message),
      newId: () => 'id1',
    };
  }

  it('asks the owner with the pairing question, then returns the entry to add', () => {
    const p = prompts(true);
    expect(acceptPairingLink([], link, p)).toEqual({ id: 'id1', name: 'dev', url: link.url, token: '', agentKey: link.agentKey, pairing: link.secret });
    expect(p.asked).toEqual([pairingQuestion(link)]);
    expect(p.alerts).toEqual([]);
  });

  it('returns nothing when the owner declines', () => {
    const p = prompts(false);
    expect(acceptPairingLink([], link, p)).toBeNull();
    expect(p.asked).toHaveLength(1);
  });

  it('says why a link is refused, without asking', () => {
    const p = prompts(true);
    const existing: MachineConfig = { id: 'm1', name: 'dev', url: link.url, token: 'tok', agentKey: 'A'.repeat(43) };
    expect(acceptPairingLink([existing], link, p)).toBeNull();
    expect(p.alerts).toEqual([expect.stringContaining('another key for dev')]);
    expect(p.asked).toEqual([]);
  });
});

describe('readPairingLink', () => {
  it('takes a link made for this app, or its bare fragment', () => {
    const full = pairingLink('https://pwa.example', link);
    expect(readPairingLink(full, 'https://pwa.example')).toEqual({ ok: true, link });
    expect(readPairingLink(new URL(full).hash, 'https://pwa.example')).toEqual({ ok: true, link });
  });

  // Any page can make a pairing link; one naming another origin was made for another Perch.
  it("refuses a link for another origin, saying whose it is", () => {
    const result = readPairingLink(pairingLink('https://elsewhere.example', link), 'https://pwa.example');
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('elsewhere.example') });
  });

  it('says so when the text is no pairing link at all', () => {
    expect(readPairingLink('https://pwa.example/', 'https://pwa.example')).toEqual({ ok: false, reason: expect.stringMatching(/not a Perch pairing code/) });
  });
});

describe('pairingQuestion', () => {
  it("names the relay's host and the machine key's fingerprint, which perch pair prints too", () => {
    const question = pairingQuestion(link);
    expect(question).toContain('relay.example');
    expect(question).toContain(deviceFingerprint(link.agentKey));
  });
});

describe('takePairingFragment', () => {
  it('reads the link off the location and removes the fragment before anything else can see it', () => {
    const full = new URL(pairingLink('https://pwa.example', link));
    // Live, like window.location: replacing the URL empties the hash.
    const location = { hash: full.hash, pathname: '/', search: '' };
    const replaced: string[] = [];
    const taken = takePairingFragment(location, (url) => {
      replaced.push(url);
      location.hash = '';
    });
    expect(taken).toEqual(link);
    expect(replaced).toEqual(['/']);
    expect(replaced[0]).not.toContain(link.secret);
  });

  it('leaves any other location alone', () => {
    const replaced: string[] = [];
    expect(takePairingFragment({ hash: '', pathname: '/', search: '?x=1' }, (url) => replaced.push(url))).toBeNull();
    expect(takePairingFragment({ hash: '#other', pathname: '/', search: '' }, (url) => replaced.push(url))).toBeNull();
    expect(replaced).toEqual([]);
  });

  it('removes a malformed pairing fragment too, so a secret never stays in the address bar', () => {
    const replaced: string[] = [];
    expect(takePairingFragment({ hash: '#pair?s=half', pathname: '/', search: '' }, (url) => replaced.push(url))).toBeNull();
    expect(replaced).toEqual(['/']);
  });
});

describe('outsideInstalledApp', () => {
  it('is true only where iOS says the page is not the Home Screen app', () => {
    expect(outsideInstalledApp({ standalone: false })).toBe(true);
    expect(outsideInstalledApp({ standalone: true })).toBe(false);
    expect(outsideInstalledApp({})).toBe(false);
  });
});
