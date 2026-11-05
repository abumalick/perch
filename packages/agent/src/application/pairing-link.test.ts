import { describe, expect, it } from 'vitest';
import { generateAgentKeys, parsePairingLink } from '@perch/secure-channel';
import type { PairingStorePort } from '../ports/pairing-store-port';
import { mintPairingLink, pairingName, type PairingDeps } from './pairing-link';
import { PAIRING_TTL_MS, type Pairing } from './pairing';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const keys = generateAgentKeys();
const ADDRESS = 'wss://dev.example.ts.net:10000/abu';

function setup(options: { defaultPath?: string } = {}) {
  let pairingList: Pairing[] = [];
  const pairings: PairingStorePort = {
    read: async () => pairingList,
    update: async (change) => (pairingList = change(pairingList)),
  };
  let n = 0;
  const deps: PairingDeps = {
    keys,
    machineId: 'dev',
    pairings,
    newSecret: () => String(++n).padStart(43, 'x'),
    now: () => NOW,
    ...(options.defaultPath !== undefined ? { defaultPath: options.defaultPath } : {}),
  };
  return { deps, pairings: () => pairingList };
}

describe('mintPairingLink', () => {
  it('stores a ten-minute, one-time secret and puts it in the link fragment', async () => {
    const s = setup();
    const link = await mintPairingLink(s.deps, { phoneUrls: [ADDRESS], pwaOrigin: 'https://pwa.example' });
    const [stored] = s.pairings();
    expect(Date.parse(stored!.expiresAt) - NOW.getTime()).toBe(PAIRING_TTL_MS);
    expect(link.split('#')[0]).toBe('https://pwa.example/');
    expect(parsePairingLink(link)!.secret).toBe(stored!.secret);
    expect(parsePairingLink(link)!.agentKey).toBe(keys.x25519.publicKey);
  });

  it('carries every phone address, in order, as given', async () => {
    const phoneUrls = [ADDRESS, 'wss://dev.example.ts.net:8443/abu'];
    const link = await mintPairingLink(setup().deps, { phoneUrls, pwaOrigin: 'https://tarfa.app' });
    expect(parsePairingLink(link)!.urls).toEqual(phoneUrls);
  });

  // A path the phone would drop is refused before a secret is minted, rather than silently ignored.
  it('carries the default path when the machine has one, and refuses one the phone would drop', async () => {
    const mint = (defaultPath?: string) => mintPairingLink(setup({ defaultPath }).deps, { phoneUrls: [ADDRESS], pwaOrigin: 'https://pwa.example' });
    expect(parsePairingLink(await mint('/home/u/workspace'))!.defaultPath).toBe('/home/u/workspace');
    expect(parsePairingLink(await mint())!.defaultPath).toBeUndefined();
    const s = setup({ defaultPath: 'workspace' });
    await expect(mintPairingLink(s.deps, { phoneUrls: [ADDRESS], pwaOrigin: 'https://pwa.example' })).rejects.toThrow(/PERCH_DEFAULT_PATH.*absolute/);
    expect(s.pairings()).toEqual([]);
  });
});

describe('pairingName', () => {
  it('is the configured machine id', () => {
    expect(pairingName('studio', 'box.example.net')).toBe('studio');
  });

  it('is the host name, without its domain, when the machine id is a generic placeholder', () => {
    expect(pairingName('local', 'box.example.net')).toBe('box');
    expect(pairingName('localhost', 'box')).toBe('box');
    expect(pairingName('', 'box')).toBe('box');
  });
});
