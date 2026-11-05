// The phone port end to end, over real sockets: the production listener (`startPhoneListener`)
// with the shared device gate over real roster and pairing files, and a client that plays the
// phone with the PWA's own steps (IK against the agent's key, then `auth`). Only tmux and the
// terminal are fakes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import {
  DEVICE_REFUSED,
  IN_BAND_REFUSAL,
  IkInitiator,
  MAX_FRAME_BYTES,
  REFUSAL,
  SecureSession,
  b64url,
  encodeDeviceHello,
  generateAgentKeys,
  generateDeviceKeys,
  handshakeFrame,
  rawStaticKey,
  readHandshakeFrame,
  type AgentKeys,
  type DeviceKeys,
} from '@tarfa/secure-channel';
import { PROTOCOL_VERSION } from '@tarfa/contracts';
import { WsServer } from './ws-server';
import { startDeviceGate, type AgentDeviceGate } from './device-gate-wiring';
import { startPhoneListener } from '../infrastructure/phone-listener';
import { PhoneAdmission } from '../application/phone-admission';
import { DiskReadLimiter } from '../application/disk-read-limiter';
import { loadConfig, type AgentConfig } from '../infrastructure/config';
import { FileDeviceStore } from '../infrastructure/file-device-store';
import { FilePairingStore } from '../infrastructure/file-pairing-store';
import { FileParkedStore } from '../infrastructure/file-parked-store';
import { InMemoryStatusStore } from '../infrastructure/in-memory-status-store';
import { systemClock, RandomIdGenerator, systemPathResolver } from '../infrastructure/system';
import { enrolDevice, revokeDevice, withEnrolmentMode } from '../application/device-roster';
import { addPairing } from '../application/pairing';
import type { TmuxPort } from '../ports/tmux-port';
import type { PtyPort } from '../ports/pty-port';

const TOKEN = 'integration-token';
type Message = { type: string; [key: string]: unknown };

const noTmux: TmuxPort = {
  listSessions: async () => [],
  createSession: async () => undefined,
  killSession: async () => undefined,
  hasSession: async () => false,
};
const noPty = {
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
    launchers: { list: async () => [], remember: async () => {}, forget: async () => {} },
    detectInstalled: async () => [],
    keyterms: { list: async () => [] },
    clientLog: { append: async () => undefined },
    workspaceLog: { append: async () => undefined },
    parked: new FileParkedStore(config.parkedStorePath),
    connectUpstream: () => Promise.reject(new Error('unexpected upstream dial')),
  });
}

interface Stack {
  home: string;
  keys: AgentKeys;
  gate: AgentDeviceGate;
  store: FileDeviceStore;
  listener: { port: number; close(): Promise<void> };
  url: string;
}

interface StackOptions {
  admission?: PhoneAdmission;
  authTimeoutMs?: number;
  heartbeatMs?: number;
}

async function startStack(opts: StackOptions = {}): Promise<Stack> {
  const home = await mkdtemp(join(tmpdir(), 'perch-phone-it-'));
  const keys = generateAgentKeys();
  const config = loadConfig({ TARFA_MACHINE_ID: 'it', TARFA_TOKEN: TOKEN }, home);
  const server = serverFor(config);
  const store = new FileDeviceStore(config.devicesPath);
  const gate = startDeviceGate({
    keys,
    server,
    store,
    pairings: new FilePairingStore(config.pairingPath),
    log: () => undefined,
    rosterPollMs: 60_000,
  });
  const authTimeoutMs = opts.authTimeoutMs;
  const listener = await startPhoneListener({
    port: 0,
    gate,
    server,
    admission: opts.admission ?? new PhoneAdmission({ now: () => Date.now() }),
    limiter: new DiskReadLimiter(() => Date.now()),
    log: () => undefined,
    ...(opts.heartbeatMs ? { heartbeatMs: opts.heartbeatMs } : {}),
    ...(authTimeoutMs
      ? {
          startTimer: (fn: () => void) => {
            const t = setTimeout(fn, authTimeoutMs);
            return () => clearTimeout(t);
          },
        }
      : {}),
  });
  return { home, keys, gate, store, listener, url: `ws://127.0.0.1:${listener.port}` };
}

async function enrolled(stack: Stack): Promise<DeviceKeys> {
  const device = generateDeviceKeys();
  await stack.store.update((roster) =>
    enrolDevice(roster, { x25519: device.x25519.publicKey, ed25519: device.ed25519.publicKey, name: 'phone' }, new Date()),
  );
  await stack.gate.pollRoster();
  return device;
}

interface Opened {
  socket: WebSocket;
  closed: Promise<{ code: number; reason: string }>;
}

function open(url: string, headers: Record<string, string> = {}): Promise<Opened> {
  const socket = new WebSocket(url, { headers });
  socket.on('error', () => undefined);
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket, closed }));
    socket.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });
}

interface Phone {
  send(message: Record<string, unknown>): void;
  next(type: string): Promise<Message>;
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

// What a PWA from before direct connections puts in its hello: an Ed25519 signature for a relay
// (86 base64url characters). The agent no longer reads it.
const OLD_RELAY_PROOF = 'A'.repeat(86);

// What the PWA does on a direct entry: open the socket, run IK against the agent's key. `hello`
// 'proof' builds the hello as a PWA from before direct connections did, signed for a relay.
async function phone(stack: Stack, device: DeviceKeys, path = '/', hello: 'plain' | 'proof' = 'plain'): Promise<Phone> {
  const { socket, closed } = await open(`${stack.url}${path}`);
  const inbox: Message[] = [];
  const waiters: Array<{ type: string; resolve: (m: Message) => void }> = [];
  const deliver = (message: Message) => {
    const at = waiters.findIndex((w) => w.type === message.type);
    if (at === -1) inbox.push(message);
    else waiters.splice(at, 1)[0]!.resolve(message);
  };
  return new Promise<Phone>((resolve, reject) => {
    void closed.then((close) => reject(Object.assign(new Error(`closed ${close.code} ${close.reason}`), close)));
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
          ...(hello === 'proof'
            ? { proof: OLD_RELAY_PROOF }
            : {}),
        }),
      )
      .then((m1) => socket.send(handshakeFrame(m1, 'ik')));
  });
}

async function newPairing(stack: Stack): Promise<string> {
  const secret = b64url.encode(randomBytes(32));
  await new FilePairingStore(join(stack.home, '.tarfa', 'pairing.json')).update((list) => addPairing(list, secret, new Date()));
  return secret;
}

async function get(stack: Stack, path: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${stack.listener.port}${path}`, { method: path === '/hooks' ? 'POST' : 'GET' });
  return res.status;
}

describe('phones on the phone port', () => {
  let stack: Stack;
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    cleanups.splice(0).forEach((c) => c());
    stack.gate.stop();
    await stack.listener.close();
    await rm(stack.home, { recursive: true, force: true });
  });

  describe('with the default bounds', () => {
    beforeEach(async () => {
      stack = await startStack();
    });

    for (const path of ['/', '/some-slug']) {
      it(`serves an enrolled phone on ${path}, naming the agent protocol`, async () => {
        const device = await enrolled(stack);
        const conn = await phone(stack, device, path);
        cleanups.push(() => conn.close());
        conn.send({ type: 'auth', token: '' });
        const result = await conn.next('authResult');
        expect(result).toMatchObject({ ok: true, credential: 'device', enrolled: true, agent: { protocol: PROTOCOL_VERSION } });
        conn.send({ type: 'list' });
        expect(await conn.next('workspaces')).toMatchObject({ workspaces: [] });
      });
    }

    for (const hello of ['plain', 'proof'] as const) {
      it(`enrols a phone with a pairing code and no token, its hello ${hello === 'proof' ? 'still carrying an old relay proof' : 'carrying no proof'}`, async () => {
        const device = generateDeviceKeys();
        const conn = await phone(stack, device, '/', hello);
        cleanups.push(() => conn.close());
        conn.send({ type: 'auth', token: await newPairing(stack) });
        expect(await conn.next('authResult')).toMatchObject({ ok: true, credential: 'pairing', enrolled: true });
        conn.send({ type: 'list' });
        expect(await conn.next('workspaces')).toMatchObject({ workspaces: [] });
        expect((await stack.store.read()).devices.map((d) => d.x25519)).toEqual([device.x25519.publicKey]);

        const again = await phone(stack, device, '/', hello);
        cleanups.push(() => again.close());
        again.send({ type: 'auth', token: '' });
        expect(await again.next('authResult')).toMatchObject({ ok: true, credential: 'device' });
      });
    }

    it('enrols a phone with the token, then refuses the token from it once enrolled', async () => {
      const device = generateDeviceKeys();
      const conn = await phone(stack, device);
      conn.send({ type: 'auth', token: TOKEN });
      expect(await conn.next('authResult')).toMatchObject({ ok: true, credential: 'token', enrolled: true });
      conn.close();
      const stale = await phone(stack, device);
      stale.send({ type: 'auth', token: TOKEN });
      expect(await stale.closed).toEqual({ code: DEVICE_REFUSED, reason: REFUSAL.tokenNotNeeded });
    });

    it('refuses the token while enrolment is off, and a pairing code once it is closed', async () => {
      await stack.store.update((roster) => withEnrolmentMode(roster, 'off'));
      const byToken = await phone(stack, generateDeviceKeys());
      byToken.send({ type: 'auth', token: TOKEN });
      expect(await byToken.closed).toEqual({ code: DEVICE_REFUSED, reason: REFUSAL.enrolmentOff });
      // A pairing code is an explicit authorisation, so `off` still takes it.
      const paired = await phone(stack, generateDeviceKeys());
      cleanups.push(() => paired.close());
      paired.send({ type: 'auth', token: await newPairing(stack) });
      expect(await paired.next('authResult')).toMatchObject({ ok: true, credential: 'pairing' });

      await stack.store.update((roster) => withEnrolmentMode(roster, 'closed'));
      await expect(phone(stack, generateDeviceKeys())).rejects.toMatchObject({ code: DEVICE_REFUSED, reason: REFUSAL.notEnrolled });
    });

    it('fails to start on a port another listener holds', async () => {
      await expect(
        startPhoneListener({
          port: stack.listener.port,
          gate: stack.gate,
          server: { acceptPhoneSocket: () => undefined },
          admission: new PhoneAdmission({ now: () => Date.now() }),
          limiter: new DiskReadLimiter(() => Date.now()),
          log: () => undefined,
        }),
      ).rejects.toThrow(/EADDRINUSE/);
    });

    it('answers anything but an upgrade 404, the hooks routes included', async () => {
      expect(await get(stack, '/hooks')).toBe(404);
      expect(await get(stack, '/')).toBe(404);
      expect(await get(stack, '/message')).toBe(404);
    });

    it('closes the direct session of a device revoked behind its back', async () => {
      const device = await enrolled(stack);
      const conn = await phone(stack, device);
      conn.send({ type: 'auth', token: '' });
      await conn.next('authResult');
      await stack.store.update((roster) => revokeDevice(roster, device.x25519.publicKey, new Date()).roster);
      await stack.gate.pollRoster();
      expect(await conn.closed).toEqual({ code: DEVICE_REFUSED, reason: REFUSAL.revoked });
    });

    it('refuses an unknown key that offers no credential', async () => {
      const conn = await phone(stack, generateDeviceKeys());
      conn.send({ type: 'auth', token: '' });
      expect(await conn.closed).toEqual({ code: DEVICE_REFUSED, reason: REFUSAL.notEnrolled });
    });

    it('closes a socket that sends a frame over the largest one', async () => {
      const { socket, closed } = await open(stack.url);
      socket.send(new Uint8Array(MAX_FRAME_BYTES + 1));
      expect((await closed).code).toBe(1009);
    });

    it('closes the oldest unauthenticated socket when 33 are open, and keeps the newest', async () => {
      const sockets: Opened[] = [];
      for (let i = 0; i < 32; i++) sockets.push(await open(stack.url));
      const newest = await open(stack.url);
      cleanups.push(() => [...sockets, newest].forEach((s) => s.socket.terminate()));
      expect(await sockets[0]!.closed).toEqual({ code: IN_BAND_REFUSAL + 429, reason: REFUSAL.tooManyPending });
      expect(newest.socket.readyState).toBe(WebSocket.OPEN);
      expect(sockets[1]!.socket.readyState).toBe(WebSocket.OPEN);
    });

    it('never evicts an authenticated phone, however many strangers come after it', async () => {
      const device = await enrolled(stack);
      const conn = await phone(stack, device);
      cleanups.push(() => conn.close());
      conn.send({ type: 'auth', token: '' });
      await conn.next('authResult');
      const strangers: Opened[] = [];
      for (let i = 0; i < 40; i++) strangers.push(await open(stack.url));
      cleanups.push(() => strangers.forEach((s) => s.socket.terminate()));
      await strangers[7]!.closed;
      conn.send({ type: 'list' });
      expect(await conn.next('workspaces')).toMatchObject({ workspaces: [] });
    });

    it('refuses a ninth unauthenticated socket from one forwarded address, in band', async () => {
      const sockets: Opened[] = [];
      for (let i = 0; i < 8; i++) sockets.push(await open(stack.url, { 'x-forwarded-for': '203.0.113.7' }));
      cleanups.push(() => sockets.forEach((s) => s.socket.terminate()));
      const ninth = await open(stack.url, { 'x-forwarded-for': '198.51.100.1, 203.0.113.7' });
      expect(await ninth.closed).toEqual({ code: IN_BAND_REFUSAL + 429, reason: REFUSAL.tooManyConnections });
      const other = await open(stack.url, { 'x-forwarded-for': '203.0.113.8' });
      cleanups.push(() => other.socket.terminate());
      expect(other.socket.readyState).toBe(WebSocket.OPEN);
    });
  });

  it('closes a socket that never authenticates, and frees its slot', async () => {
    stack = await startStack({ admission: new PhoneAdmission({ now: () => Date.now(), perAddress: 1 }), authTimeoutMs: 100 });
    const idle = await open(stack.url, { 'x-forwarded-for': '203.0.113.7' });
    expect(await idle.closed).toEqual({ code: 4002, reason: 'authentication timeout' });
    const next = await open(stack.url, { 'x-forwarded-for': '203.0.113.7' });
    cleanups.push(() => next.socket.terminate());
    await new Promise((r) => setTimeout(r, 30));
    expect(next.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('terminates a socket that stops answering pings', async () => {
    stack = await startStack({ heartbeatMs: 50 });
    // A raw upgrade that never answers a ping (a ws client would, on its own).
    const raw = connect(stack.listener.port, '127.0.0.1');
    raw.write(
      'GET /x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
    );
    let response = '';
    raw.on('data', (chunk: Buffer) => (response += chunk.toString('latin1')));
    raw.on('error', () => undefined);
    await new Promise<void>((resolve) => raw.once('close', () => resolve()));
    expect(response.startsWith('HTTP/1.1 101')).toBe(true);
  });
});
