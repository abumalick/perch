// The agent's relay path end to end, over real sockets: the production relay wiring
// (`startRelayLinks`: RelayLink over the ws transport, the device gate over real roster and
// pairing files) → the self-hosted relay server (`@perch/relay`) on an ephemeral port → a client
// that plays the phone with the PWA's own steps (challenge, device signature, enrolment proof, IK,
// `auth`). Only tmux and the terminal are fakes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import {
  DEVICE_REFUSED,
  IN_BAND_REFUSAL,
  IkInitiator,
  REFUSAL,
  SecureSession,
  accountId,
  b64url,
  ed25519Signer,
  encodeDeviceHello,
  signDeviceHello,
  enrolKey,
  enrolProof,
  generateAgentKeys,
  generateDeviceKeys,
  handshakeFrame,
  rawStaticKey,
  readHandshakeFrame,
  signDeviceAuth,
  type AgentKeys,
  type DeviceKeys,
} from '@perch/secure-channel';
import { MemoryRegistry } from '@perch/relay/registry';
import { startRelayServer, type RelayServer } from '@perch/relay/server';
import { WsServer } from './ws-server';
import { startRelayLinks, type RelayWiring } from './relay-wiring';
import { loadConfig, type AgentConfig } from '../infrastructure/config';
import { createWsRelayTransport } from '../infrastructure/ws-relay-transport';
import { frameSocketTransport } from '../infrastructure/ws-frame-socket';
import type { FrameSocket } from '../ports/frame-socket';
import { FileDeviceStore } from '../infrastructure/file-device-store';
import { FilePairingStore } from '../infrastructure/file-pairing-store';
import { FileParkedStore } from '../infrastructure/file-parked-store';
import { InMemoryStatusStore } from '../infrastructure/in-memory-status-store';
import { systemClock, RandomIdGenerator, systemPathResolver } from '../infrastructure/system';
import { addPairing } from '../application/pairing';
import { revokeDevice, withEnrolmentMode, type EnrolmentMode } from '../application/device-roster';
import type { RelayTransport } from '../ports/relay-port';
import type { TmuxPort } from '../ports/tmux-port';
import type { PtyPort } from '../ports/pty-port';

const TOKEN = 'integration-token';
type Message = { type: string; [key: string]: unknown };

interface Stack {
  home: string;
  keys: AgentKeys;
  account: string;
  relay: RelayServer;
  relays: RelayWiring;
  server: WsServer;
  store: FileDeviceStore;
  pairings: FilePairingStore;
  logs: string[];
  // Resolves once the relay has acknowledged a policy published after this call.
  nextApplied(): Promise<void>;
  url: string;
}

const noTmux: TmuxPort = {
  listSessions: async () => [],
  createSession: async () => undefined,
  killSession: async () => undefined,
  hasSession: async () => false,
};
const noPty: PtyPort = {
  spawn: () => {
    throw new Error('unexpected terminal');
  },
} as unknown as PtyPort;

function serverFor(config: AgentConfig): WsServer {
  return new WsServer({
    config,
    tmux: noTmux,
    recent: { add: async () => undefined, list: async () => [] } as never,
    lister: { list: async () => [] } as never,
    reader: { read: async () => null } as never,
    resolvePath: systemPathResolver,
    isDirectory: async () => true,
    clock: systemClock,
    ids: new RandomIdGenerator(),
    pty: noPty,
    status: new InMemoryStatusStore(),
    writer: { write: async () => undefined } as never,
    browserDiscovery: { listSessions: async () => [] },
    browserCommands: {
      start: async () => undefined,
      navigate: async () => undefined,
      back: async () => undefined,
      forward: async () => undefined,
      stop: async () => undefined,
      setViewport: async () => undefined,
    },
    hiddenFolders: { list: async () => [] },
    commands: { list: async () => [] },
    launchers: { list: async () => [], remember: async () => {}, forget: async () => {} },
    detectInstalled: async () => [],
    keyterms: { list: async () => [] },
    clientLog: { append: async () => undefined },
    workspaceLog: { append: async () => undefined },
    parked: new FileParkedStore(config.parkedStorePath),
    connectUpstream: () => Promise.reject(new Error('unexpected upstream dial')),
  });
}

// The production ws transport, watched: each `applied` the relay sends on a control socket.
function watchedTransport(onApplied: () => void): RelayTransport<FrameSocket> {
  const inner = frameSocketTransport(createWsRelayTransport());
  return {
    dial: (url, headers) => inner.dial(url, headers),
    openControl(url, headers) {
      const control = inner.openControl(url, headers);
      control.onMessage((text) => {
        if (text.includes('"applied"')) onApplied();
      });
      return control;
    },
  };
}

async function startStack(): Promise<Stack> {
  const home = await mkdtemp(join(tmpdir(), 'perch-relay-it-'));
  const keys = generateAgentKeys();
  const account = accountId(keys.ed25519.publicKey);
  const relay = await startRelayServer({
    port: 0,
    registry: new MemoryRegistry({ accounts: { [account]: { key: keys.ed25519.publicKey, addedAt: new Date().toISOString() } } }),
    heartbeatMs: 60_000,
  });
  const url = `ws://127.0.0.1:${relay.port}`;
  const config = loadConfig({ PERCH_MACHINE_ID: 'it', PERCH_TOKEN: TOKEN, PERCH_RELAY_URLS: url }, home);
  const server = serverFor(config);
  const store = new FileDeviceStore(config.devicesPath);
  const pairings = new FilePairingStore(config.pairingPath);
  const logs: string[] = [];
  let appliedWaiters: Array<() => void> = [];
  const firstApplied = new Promise<void>((resolve) => appliedWaiters.push(resolve));
  const transport = watchedTransport(() => {
    const waiters = appliedWaiters;
    appliedWaiters = [];
    waiters.forEach((w) => w());
  });
  const relays = startRelayLinks({
    config: { relayUrls: config.relayUrls, token: TOKEN },
    keys,
    server,
    store,
    pairings,
    transport,
    log: (line) => logs.push(line),
    rosterPollMs: 60_000,
  });
  await firstApplied;
  return {
    home,
    keys,
    account,
    relay,
    relays,
    server,
    store,
    pairings,
    logs,
    url,
    nextApplied: () => new Promise<void>((resolve) => appliedWaiters.push(resolve)),
  };
}

interface Phone {
  send(message: Record<string, unknown>): void;
  next(type: string): Promise<Message>;
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

type Proof = { secret: string; cred: 'pairing' | 'token' };

// What the PWA does for a relay entry: sign a fresh challenge with the device key (with an
// enrolment proof when it holds a credential), upgrade, then run IK against the agent's key.
// Resolves once the session is up; rejects with the close if the relay or agent refuses first.
async function phone(stack: Stack, device: DeviceKeys, proof?: Proof): Promise<Phone> {
  const res = await fetch(`${stack.url.replace(/^ws/, 'http')}/${stack.account}?role=challenge`);
  const { nonce } = (await res.json()) as { nonce: string };
  const claim = { account: stack.account, nonce, device: device.ed25519.publicKey };
  const target = new URL(`${stack.url}/${stack.account}`);
  target.searchParams.set('device', claim.device);
  target.searchParams.set('nonce', nonce);
  target.searchParams.set('sig', await signDeviceAuth(ed25519Signer(device.ed25519.privateKey), claim));
  if (proof) {
    target.searchParams.set('proof', enrolProof(enrolKey(proof.secret, stack.account), claim));
    target.searchParams.set('cred', proof.cred);
  }
  const socket = new WebSocket(target);
  socket.on('error', () => undefined);
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  const inbox: Message[] = [];
  const waiters: Array<{ type: string; resolve: (m: Message) => void }> = [];
  const deliver = (message: Message) => {
    const at = waiters.findIndex((w) => w.type === message.type);
    if (at === -1) inbox.push(message);
    else waiters.splice(at, 1)[0]!.resolve(message);
  };
  return new Promise<Phone>((resolve, reject) => {
    void closed.then((close) => reject(Object.assign(new Error(`closed ${close.code} ${close.reason}`), close)));
    socket.once('open', () => {
      const initiator = new IkInitiator(rawStaticKey(b64url.decode(device.x25519.privateKey)), b64url.decode(stack.keys.x25519.publicKey));
      socket.once('message', async (data: Buffer) => {
        await initiator.readMessage2(readHandshakeFrame(new Uint8Array(data), 'ik'));
        const { send, recv } = initiator.split();
        const session = new SecureSession(send, recv);
        socket.on('message', (frame: Buffer) => {
          const message = session.open(new Uint8Array(frame));
          if (message) deliver(JSON.parse(new TextDecoder().decode(message)) as Message);
        });
        resolve({
          send: (message) => {
            for (const frame of session.seal(new TextEncoder().encode(JSON.stringify(message)))) socket.send(frame);
          },
          next: (type) => {
            const at = inbox.findIndex((m) => m.type === type);
            if (at !== -1) return Promise.resolve(inbox.splice(at, 1)[0]!);
            return new Promise((r) => waiters.push({ type, resolve: r }));
          },
          closed,
          close: () => socket.close(),
        });
      });
      void initiator
        .writeMessage1(async (hash) =>
          encodeDeviceHello({
            sig: device.ed25519.publicKey,
            name: 'integration phone',
            proof: await signDeviceHello(ed25519Signer(device.ed25519.privateKey), b64url.decode(device.x25519.publicKey), hash),
          }),
        )
        .then((m1) => socket.send(handshakeFrame(m1, 'ik')));
    });
  });
}

async function authenticated(stack: Stack, device: DeviceKeys, token: string, proof?: Proof): Promise<Phone> {
  const conn = await phone(stack, device, proof);
  conn.send({ type: 'auth', token });
  expect(await conn.next('authResult')).toMatchObject({ ok: true });
  return conn;
}

// The refusal a connect attempt ends with, from the relay (in band) or the agent.
async function refusal(attempt: Promise<Phone>): Promise<{ code: number; reason: string }> {
  try {
    const conn = await attempt;
    conn.close();
    throw new Error('expected a refusal, got a session');
  } catch (err) {
    const { code, reason } = err as { code?: number; reason?: string };
    if (code === undefined) throw err;
    return { code, reason: reason ?? '' };
  }
}

async function newPairing(stack: Stack): Promise<string> {
  const secret = b64url.encode(randomBytes(32));
  await stack.pairings.update((list) => addPairing(list, secret, new Date()));
  return secret;
}

// Pairs a new phone with a code, as a scanned QR code does: no token anywhere.
async function pairPhone(stack: Stack): Promise<{ device: DeviceKeys; conn: Phone }> {
  const device = generateDeviceKeys();
  const secret = await newPairing(stack);
  const applied = stack.nextApplied();
  const conn = await authenticated(stack, device, secret, { secret, cred: 'pairing' });
  // Enrolment republishes the policy; the relay has it once it answers `applied`.
  await applied;
  return { device, conn };
}

describe('the agent through a real relay', () => {
  let stack: Stack;
  const open: Phone[] = [];

  beforeEach(async () => {
    stack = await startStack();
  });

  afterEach(async () => {
    open.splice(0).forEach((c) => c.close());
    stack.relays.stop();
    await stack.relay.close();
    await rm(stack.home, { recursive: true, force: true });
  });

  it('enrols a phone with a pairing code and serves it, with no token', async () => {
    const { device, conn } = await pairPhone(stack);
    open.push(conn);
    conn.send({ type: 'list' });
    expect(await conn.next('workspaces')).toMatchObject({ workspaces: [] });
    const roster = await stack.store.read();
    expect(roster.devices.map((d) => d.x25519)).toEqual([device.x25519.publicKey]);
    expect(stack.logs.some((l) => l.includes('pairing code used by device'))).toBe(true);
  });

  it('enrols a phone with a token proof, which then forgets the token and reconnects by its key', async () => {
    const device = generateDeviceKeys();
    const applied = stack.nextApplied();
    const conn = await phone(stack, device, { secret: TOKEN, cred: 'token' });
    conn.send({ type: 'auth', token: TOKEN });
    expect(await conn.next('authResult')).toMatchObject({ ok: true, credential: 'token', enrolled: true });
    await applied;
    conn.close();
    expect((await stack.store.read()).devices.map((d) => d.ed25519)).toEqual([device.ed25519.publicKey]);

    const again = await authenticated(stack, device, '');
    open.push(again);
    // Still sending the token once enrolled hands it to whoever holds the relay key: refused.
    const stale = await phone(stack, device);
    stale.send({ type: 'auth', token: TOKEN });
    expect(await stale.closed).toEqual({ code: DEVICE_REFUSED, reason: REFUSAL.tokenNotNeeded });
  });

  it('carries an enrolment-mode change to the relay: off refuses a token proof there, closed any proof', async () => {
    const setMode = async (mode: EnrolmentMode) => {
      await stack.store.update((roster) => withEnrolmentMode(roster, mode));
      const applied = stack.nextApplied();
      await stack.relays.pollRoster();
      await applied;
    };
    await setMode('off');
    expect(await refusal(phone(stack, generateDeviceKeys(), { secret: TOKEN, cred: 'token' }))).toEqual({
      code: IN_BAND_REFUSAL + 403,
      reason: REFUSAL.enrolmentOff,
    });
    // A pairing code is an explicit authorisation, so `off` still takes it.
    const { conn } = await pairPhone(stack);
    open.push(conn);

    await setMode('closed');
    const secret = await newPairing(stack);
    expect(await refusal(phone(stack, generateDeviceKeys(), { secret, cred: 'pairing' }))).toEqual({
      code: IN_BAND_REFUSAL + 403,
      reason: REFUSAL.enrolmentClosed,
    });
    // The relay refused both from the published policy: the agent was never asked (it logs
    // each enrolment it refuses itself).
    expect(stack.logs.filter((line) => line.includes('refused an enrolment'))).toEqual([]);
  });

  it('reconnects a paired phone by its key alone: no proof, an empty token', async () => {
    const { device, conn } = await pairPhone(stack);
    conn.close();
    const again = await authenticated(stack, device, '');
    open.push(again);
    again.send({ type: 'list' });
    expect(await again.next('workspaces')).toMatchObject({ type: 'workspaces' });
  });

  it('publishes the roster to the relay: unknown keys refused, enrolled admitted, revoked refused', async () => {
    const stranger = generateDeviceKeys();
    expect(await refusal(phone(stack, stranger))).toEqual({ code: IN_BAND_REFUSAL + 403, reason: REFUSAL.notEnrolled });

    // Admitted by the relay without a proof: its Ed25519 key is in the published policy.
    const { device, conn } = await pairPhone(stack);
    conn.close();
    open.push(await authenticated(stack, device, ''));

    await stack.store.update((roster) => revokeDevice(roster, roster.devices[0]!.id, new Date()).roster);
    const applied = stack.nextApplied();
    await stack.relays.pollRoster();
    await applied;
    expect(await refusal(phone(stack, device))).toEqual({ code: IN_BAND_REFUSAL + 403, reason: REFUSAL.revoked });
  });

  it('closes a revoked phone: its live session at once, and at the agent when the relay has not heard yet', async () => {
    const { device, conn } = await pairPhone(stack);
    const liveClosed = conn.closed;
    const [enrolled] = (await stack.store.read()).devices;
    // Revoked in the file by another process (`perch devices revoke`), not yet noticed: the relay
    // still lists the key, so it lets the phone through, and the agent refuses it itself.
    await stack.store.update((roster) => revokeDevice(roster, enrolled!.id, new Date()).roster);
    expect(await refusal(phone(stack, device))).toEqual({ code: DEVICE_REFUSED, reason: REFUSAL.revoked });

    // The monitor notices: the live session is closed and the relay refuses the key from then on.
    const applied = stack.nextApplied();
    await stack.relays.pollRoster();
    expect(await liveClosed).toMatchObject({ code: DEVICE_REFUSED });
    await applied;
    expect(await refusal(phone(stack, device))).toEqual({ code: IN_BAND_REFUSAL + 403, reason: REFUSAL.revoked });
  });

  it('opens the browser view for a paired phone: its stream is admitted with no token', async () => {
    const { conn } = await pairPhone(stack);
    open.push(conn);
    conn.send({ type: 'browserOpen', stream: 'b1', session: 'perch-demo' });
    conn.send({ type: 'browser', stream: 'b1', data: JSON.stringify({ type: 'auth', token: '' }) });
    const first = await conn.next('browser');
    expect(JSON.parse(first.data as string)).toEqual({ type: 'authResult', ok: true });
  });

  it('refuses a client without a device key: at the relay, and at the agent if one got past it', async () => {
    const bare = new WebSocket(`${stack.url}/${stack.account}`);
    bare.on('error', () => undefined);
    const bareClosed = await new Promise<{ code: number; reason: string }>((r) => bare.once('close', (code, reason) => r({ code, reason: reason.toString() })));
    expect(bareClosed).toEqual({ code: IN_BAND_REFUSAL + 401, reason: REFUSAL.deviceKeyRequired });

    // An enrolled key the relay admits, sending the retired NK handshake instead of IK.
    const { device, conn } = await pairPhone(stack);
    conn.close();
    const res = await fetch(`${stack.url.replace(/^ws/, 'http')}/${stack.account}?role=challenge`);
    const { nonce } = (await res.json()) as { nonce: string };
    const claim = { account: stack.account, nonce, device: device.ed25519.publicKey };
    const target = new URL(`${stack.url}/${stack.account}`);
    target.searchParams.set('device', claim.device);
    target.searchParams.set('nonce', nonce);
    target.searchParams.set('sig', await signDeviceAuth(ed25519Signer(device.ed25519.privateKey), claim));
    const nk = new WebSocket(target);
    nk.on('error', () => undefined);
    const nkClosed = new Promise<number>((r) => nk.once('close', (code) => r(code)));
    await new Promise((r) => nk.once('open', r));
    nk.send(Uint8Array.of(0x02, ...randomBytes(48)));
    expect(await nkClosed).toBe(4002);
  });
});
