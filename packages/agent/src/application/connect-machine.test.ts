import { describe, expect, it } from 'vitest';
import {
  accountId,
  generateAgentKeys,
  generateJoinKey,
  parsePairingLink,
  verifyAgentAuth,
  verifyJoinAuth,
} from '@perch/secure-channel';
import type { PairingStorePort } from '../ports/pairing-store-port';
import { parseEnvFile } from './agent-env';
import { connectMachine, mintPairingLink, pairingName, type ConnectDeps } from './connect-machine';
import type { JoinRequest } from '../ports/relay-join-port';
import { PAIRING_TTL_MS, type Pairing } from './pairing';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const keys = generateAgentKeys();
const account = accountId(keys.ed25519.publicKey);
const joinKey = generateJoinKey();
const ENV = 'PERCH_TOKEN=t\nPERCH_MACHINE_ID=dev\n';

function setup(options: { status?: number; env?: string; restartFails?: boolean; defaultPath?: string } = {}) {
  const joins: Array<{ relayUrl: string; request: JoinRequest }> = [];
  const writes: string[] = [];
  let restarts = 0;
  let envText = options.env ?? ENV;
  let pairingList: Pairing[] = [];
  const pairings: PairingStorePort = {
    read: async () => pairingList,
    update: async (change) => (pairingList = change(pairingList)),
  };
  let n = 0;
  const deps: ConnectDeps = {
    keys,
    machineId: 'dev',
    relay: {
      join: async (relayUrl, request) => {
        joins.push({ relayUrl, request });
        return { status: options.status ?? 201, body: 'x' };
      },
    },
    env: {
      path: '/repo/deploy/agent.env',
      read: async () => envText,
      write: async (text) => {
        writes.push(text);
        envText = text;
        return '/repo/deploy/agent.env.bak-1';
      },
    },
    service: {
      restart: async () => {
        restarts += 1;
        if (options.restartFails) throw new Error('no such unit');
        return 'systemctl --user restart perch-agent';
      },
    },
    pairings,
    newSecret: () => String(++n).padStart(43, 'x'),
    now: () => NOW,
    ...(options.defaultPath !== undefined ? { defaultPath: options.defaultPath } : {}),
  };
  return { deps, joins, writes, restarts: () => restarts, env: () => envText, pairings: () => pairingList };
}

const input = { relayUrl: 'wss://relay.example', joinKey, pwaOrigin: 'https://pwa.example:8443' };

describe('connectMachine', () => {
  // A path the phone would drop is refused before anything changes, rather than silently ignored.
  it('refuses a default path that is not absolute before joining', async () => {
    const s = setup({ defaultPath: '~/workspace' });
    await expect(connectMachine(s.deps, input)).rejects.toThrow(/PERCH_DEFAULT_PATH/);
    expect(s.joins).toEqual([]);
    expect(s.writes).toEqual([]);
  });

  it('joins with both proofs, adds the relay, restarts the agent and returns a pairing link', async () => {
    const s = setup();
    const result = await connectMachine(s.deps, input);
    const { relayUrl, request } = s.joins[0]!;
    expect(relayUrl).toBe('wss://relay.example');
    expect(request.account).toBe(account);
    expect(request.key).toBe(keys.ed25519.publicKey);
    expect(await verifyAgentAuth(request.authorization, keys.ed25519.publicKey, { account, role: 'join' }, NOW.getTime())).toBe(true);
    expect(verifyJoinAuth(request.join, joinKey, { account, role: 'join' }, NOW.getTime())).toBe(true);
    expect(parseEnvFile(s.env()).PERCH_RELAY_URLS).toBe('wss://relay.example');
    expect(parseEnvFile(s.env()).PERCH_PWA_ORIGIN).toBe('https://pwa.example:8443');
    expect(s.restarts()).toBe(1);
    const link = parsePairingLink(result.link!)!;
    expect(link).toEqual({ url: `wss://relay.example/${account}`, agentKey: keys.x25519.publicKey, secret: s.pairings()[0]!.secret, name: 'dev' });
    expect(result.link!.startsWith('https://pwa.example:8443/#pair?')).toBe(true);
    expect(result.lines.join('\n')).toContain('agent.env.bak-1');
    expect(result.lines.join('\n')).not.toContain(joinKey);
  });

  it('lets the agent reach the relay by another URL than the phone, e.g. on the relay machine itself', async () => {
    const s = setup();
    const result = await connectMachine(s.deps, { ...input, agentUrl: 'ws://127.0.0.1:8450' });
    expect(parseEnvFile(s.env()).PERCH_RELAY_URLS).toBe('ws://127.0.0.1:8450');
    expect(parsePairingLink(result.link!)!.url).toBe(`wss://relay.example/${account}`);
  });

  it('is idempotent: already joined and configured, it changes and restarts nothing', async () => {
    const s = setup({ status: 200, env: `${ENV}PERCH_RELAY_URLS=wss://relay.example\nPERCH_PWA_ORIGIN=https://pwa.example:8443\n` });
    const result = await connectMachine(s.deps, input);
    expect(s.writes).toEqual([]);
    expect(s.restarts()).toBe(0);
    expect(result.link).toBeTruthy();
  });

  it.each([
    [401, /join key/],
    [404, /does not support joining/],
    [501, /no join key/],
    [429, /too many/],
  ])('stops on a %i from the relay, touching nothing', async (status, message) => {
    const s = setup({ status });
    await expect(connectMachine(s.deps, input)).rejects.toThrow(message);
    expect(s.writes).toEqual([]);
    expect(s.restarts()).toBe(0);
    expect(s.pairings()).toEqual([]);
  });

  it('refuses a relay URL that is not ws:// or wss://', async () => {
    await expect(connectMachine(setup().deps, { ...input, relayUrl: 'https://relay.example' })).rejects.toThrow(/wss:\/\//);
  });

  it('refuses a ws:// relay that is not on loopback', async () => {
    await expect(connectMachine(setup().deps, { ...input, relayUrl: 'ws://relay.example' })).rejects.toThrow(/wss:\/\//);
    await expect(connectMachine(setup().deps, { ...input, agentUrl: 'ws://relay.example:8450' })).rejects.toThrow(/wss:\/\//);
  });

  it('still prints a pairing link when the restart fails, and says to restart by hand', async () => {
    const s = setup({ restartFails: true });
    const result = await connectMachine(s.deps, input);
    expect(result.link).toBeTruthy();
    expect(result.lines.join('\n')).toMatch(/restart the agent yourself/i);
  });

  it('configures the machine but mints no secret without a PWA origin, and says how to finish', async () => {
    const s = setup();
    const result = await connectMachine(s.deps, { ...input, pwaOrigin: undefined });
    expect(result.link).toBeUndefined();
    expect(s.pairings()).toEqual([]);
    expect(result.lines.join('\n')).toMatch(/--pwa/);
  });
});

describe('mintPairingLink', () => {
  it('stores a ten-minute, one-time secret and puts it in the link fragment', async () => {
    const s = setup();
    const link = await mintPairingLink(s.deps, { phoneUrl: 'wss://relay.example', pwaOrigin: 'https://pwa.example' });
    const [stored] = s.pairings();
    expect(Date.parse(stored!.expiresAt) - NOW.getTime()).toBe(PAIRING_TTL_MS);
    expect(link.split('#')[0]).toBe('https://pwa.example/');
    expect(parsePairingLink(link)!.secret).toBe(stored!.secret);
  });

  it('carries the default path when the machine has one', async () => {
    const mint = (defaultPath?: string) => mintPairingLink(setup({ defaultPath }).deps, { phoneUrl: 'wss://relay.example', pwaOrigin: 'https://pwa.example' });
    expect(parsePairingLink(await mint('/home/u/workspace'))!.defaultPath).toBe('/home/u/workspace');
    expect(parsePairingLink(await mint())!.defaultPath).toBeUndefined();
    await expect(mint('workspace')).rejects.toThrow(/absolute/);
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
