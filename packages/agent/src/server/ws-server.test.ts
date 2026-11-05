import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HOOK_BODY_MAX_BYTES, WsServer } from './ws-server';
import { PlainClientConnection } from './plain-client-connection.test-support';
import { TmuxAdapter } from '../infrastructure/tmux-adapter';
import { FileRecentStore } from '../infrastructure/file-recent-store';
import { FileParkedStore } from '../infrastructure/file-parked-store';
import { FileLiveSnapshotStore } from '../infrastructure/file-live-snapshot-store';
import { FsProjectLister } from '../infrastructure/fs-project-lister';
import { FsFileReader } from '../infrastructure/fs-file-reader';
import { FsFileWriter } from '../infrastructure/fs-file-writer';
import { fsIsDirectory } from '../infrastructure/fs-directory-checker';
import { NodePtyAdapter } from '../infrastructure/node-pty-adapter';
import { InMemoryStatusStore } from '../infrastructure/in-memory-status-store';
import { systemClock, RandomIdGenerator, systemPathResolver } from '../infrastructure/system';
import type { AgentConfig } from '../infrastructure/config';
import type { BrowserDiscoveryPort } from '../ports/browser-discovery-port';
import type { BrowserCommandPort } from '../ports/browser-command-port';
import type { HiddenFoldersPort } from '../ports/hidden-folders-port';
import type { LaunchersPort } from '../ports/launchers-port';
import type { KeytermsPort } from '../ports/keyterms-port';
import type { ClientLogPort } from '../ports/client-log-port';
import type { TmuxPort, TmuxSessionInfo } from '../ports/tmux-port';
import type { WorkspaceLogPort, WorkspaceLogEntry } from '../ports/workspace-log-port';
import type { ConnectUpstream } from '../ports/browser-stream-port';
import type { SystemStatsPort } from '../ports/system-stats-port';
import { connectBrowserUpstream } from '../infrastructure/ws-browser-stream-socket';
import { wsFrameSocket } from '../infrastructure/ws-frame-socket';
import type { HookEventEntry } from '../ports/hook-event-log-port';
import type { MessageLogEntry } from '../ports/message-log-port';
import type { AgentMessage } from '@perch/contracts';
import {
  SecureSession,
  IkInitiator,
  b64url,
  deviceFingerprint,
  encodeDeviceHello,
  generateAgentKeys,
  generateDeviceKeys,
  handshakeFrame,
  rawStaticKey,
  readHandshakeFrame,
  type DeviceKeys,
  type TransportPair,
} from '@perch/secure-channel';
import { FileDeviceStore } from '../infrastructure/file-device-store';
import { RosterDevices } from '../application/device-gate';
import { FilePairingStore } from '../infrastructure/file-pairing-store';
import { addPairing } from '../application/pairing';
import { revokeDevice, standingOf } from '../application/device-roster';

// Plays the phone: a Noise session against the agent's public key, IK with a device key.
// A phone with a device key (a fresh, unknown one unless given).
async function noiseClient(url: string, agentPublicKey: string, device: DeviceKeys = generateDeviceKeys()) {
  const socket = new WebSocket(url);
  await new Promise((r) => socket.once('open', r));
  const reply = new Promise<Buffer>((r) => socket.once('message', (data: Buffer) => r(data)));
  const initiator = new IkInitiator(rawStaticKey(b64url.decode(device.x25519.privateKey)), b64url.decode(agentPublicKey));
  const hello = async () => encodeDeviceHello({ sig: device.ed25519.publicKey, name: 'test phone' });
  socket.send(handshakeFrame(await initiator.writeMessage1(hello), 'ik'));
  await initiator.readMessage2(readHandshakeFrame(new Uint8Array(await reply), 'ik'));
  const split = () => initiator.split();
  const { send, recv } = split();
  const session = new SecureSession(send, recv);
  const inbox: unknown[] = [];
  const waiters: Array<(m: unknown) => void> = [];
  socket.on('message', (data: Buffer) => {
    const message = session.open(new Uint8Array(data));
    if (!message) return;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(message));
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else inbox.push(parsed);
  });
  return {
    socket,
    send: (message: unknown) => {
      for (const frame of session.seal(new TextEncoder().encode(JSON.stringify(message)))) socket.send(frame);
    },
    next: () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise<unknown>((r) => waiters.push(r))),
  };
}

const noBrowserDiscovery: BrowserDiscoveryPort = { listSessions: async () => [] };
const noBrowserCommands: BrowserCommandPort = {
  start: async () => undefined,
  navigate: async () => undefined,
  back: async () => undefined,
  forward: async () => undefined,
  stop: async () => undefined,
  setViewport: async () => undefined,
};
const noHiddenFolders: HiddenFoldersPort = { list: async () => [] };
const noLaunchers: LaunchersPort = { list: async () => [], remember: async () => {}, forget: async () => {} };
const noKeyterms: KeytermsPort = { list: async () => [] };
const noClientLog: ClientLogPort = { append: async () => {} };
const noWorkspaceLog: WorkspaceLogPort = { append: async () => {} };
const noConnectUpstream: ConnectUpstream = () => Promise.reject(new Error('unexpected upstream dial'));

const exec = promisify(execFile);
const sessions: string[] = [];
const dirs: string[] = [];
let server: WsServer | null = null;
const harnesses: WebSocketServer[] = [];

// Phones reach the agent on its phone port, in a Noise session. These tests hand the server a
// plaintext client over a local socket of their own, to exercise what it does with a client.
async function clientUrl(): Promise<string> {
  const target = server!;
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  harnesses.push(wss);
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (socket) => target.accept(new PlainClientConnection(socket)));
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const wss of harnesses.splice(0)) {
    for (const client of wss.clients) client.terminate();
    await new Promise((r) => wss.close(r));
  }
  if (server) {
    await server.stop();
    server = null;
  }
  for (const n of sessions.splice(0)) await exec('tmux', ['kill-session', '-t', n]).catch(() => undefined);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function nextMessage(socket: WebSocket): Promise<AgentMessage> {
  return new Promise((resolve) => {
    socket.once('message', (raw) => resolve(JSON.parse(raw.toString()) as AgentMessage));
  });
}

// The reply to a request, past anything pushed meanwhile: a poll tick or a status change can
// broadcast a workspaceUpdated just before it.
function replyOfType<T extends AgentMessage['type']>(socket: WebSocket, type: T): Promise<Extract<AgentMessage, { type: T }>> {
  return new Promise((resolve) => {
    const onMessage = (raw: unknown) => {
      const msg = JSON.parse(String(raw)) as AgentMessage;
      if (msg.type !== type) return;
      socket.off('message', onMessage);
      resolve(msg as Extract<AgentMessage, { type: T }>);
    };
    socket.on('message', onMessage);
  });
}

// Counts the server's finished poll ticks (pass `onPollTick` to it), so a test waits for polls
// rather than for time, which a loaded machine stretches. A tick already running when `after` is
// called counts, so `after(2)` is the first count that includes a whole tick started after it.
function pollTicks() {
  let done = 0;
  let waiters: Array<{ at: number; resolve: () => void }> = [];
  return {
    onPollTick: () => {
      done++;
      const due = waiters.filter((w) => w.at <= done);
      waiters = waiters.filter((w) => w.at > done);
      for (const w of due) w.resolve();
    },
    after: (n: number) => new Promise<void>((resolve) => waiters.push({ at: done + n, resolve })),
  };
}

// For vi.waitFor on effects of real subprocesses and file writes, which take far longer than its
// 1 s default on a loaded machine.
const LOADED_WAIT = { timeout: 15_000 };

function testConfig(home: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    machineId: 'test',
    token: 'secret',
    port: 0,
    phonePort: 0,
    phoneAddresses: [],
    pwaOrigin: 'https://pwa.example',
    projectRoots: [tmpdir()],
    recentStorePath: join(home, 'recent.json'),
    statusStorePath: join(home, 'status.json'),
    hiddenFoldersPath: join(home, 'hidden-folders.json'),
    launchersPath: join(home, 'launchers.json'),
    keytermsPath: join(home, 'keyterms.txt'),
    clientLogPath: join(home, 'client-log.jsonl'),
    hookEventLogPath: join(home, 'hook-events.jsonl'),
    messageLogPath: join(home, 'messages.jsonl'),
    workspaceLogPath: join(home, 'workspace-log.jsonl'),
    parkedStorePath: join(home, 'parked.json'),
    liveSnapshotPath: join(home, 'live.json'),
    agentKeyPath: join(home, 'relay-key.json'),
    devicesPath: join(home, 'devices.json'),
    pairingPath: join(home, 'pairing.json'),
    claudeSessionsDir: join(home, 'claude-sessions'),
    inboxDir: join(home, 'inbox'),
    sessionPrefix: 'perch-',
    ...overrides,
  };
}

// The hooks-only secret the agent writes for perch-hook.sh; deliberately not PERCH_TOKEN.
const HOOK_TOKEN = 'hook-secret';

function makeServerDeps(config: AgentConfig, clientLog: ClientLogPort) {
  return {
    config,
    hookToken: HOOK_TOKEN,
    tmux: new TmuxAdapter(),
    recent: new FileRecentStore(config.recentStorePath),
    lister: new FsProjectLister(),
    reader: new FsFileReader(),
    resolvePath: systemPathResolver,
    isDirectory: fsIsDirectory,
    clock: systemClock,
    ids: new RandomIdGenerator(),
    pty: new NodePtyAdapter(),
    status: new InMemoryStatusStore(),
    writer: new FsFileWriter(),
    browserDiscovery: noBrowserDiscovery,
    browserCommands: noBrowserCommands,
    hiddenFolders: noHiddenFolders,
    launchers: noLaunchers,
    detectInstalled: async () => [],
    keyterms: noKeyterms,
    clientLog,
    workspaceLog: noWorkspaceLog,
    parked: new FileParkedStore(config.parkedStorePath),
    connectUpstream: noConnectUpstream,
  };
}

describe('WsServer (E2E, real tmux)', () => {
  it('authenticates and lists workspaces', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-srv-'));
    dirs.push(home);
    const config = testConfig(home);
    server = new WsServer({
      config,
      hookToken: HOOK_TOKEN,
      tmux: new TmuxAdapter(),
      recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(),
      reader: new FsFileReader(),
      resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory,
      clock: systemClock,
      ids: new RandomIdGenerator(),
      pty: new NodePtyAdapter(),
      status: new InMemoryStatusStore(),
      writer: new FsFileWriter(),
      browserDiscovery: noBrowserDiscovery,
      browserCommands: noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog: noWorkspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
    });
    await server.start();
    const port = server.address().port;

    const name = `perch-${Date.now()}`;
    sessions.push(name);
    await exec('tmux', ['new-session', '-d', '-s', name, '-c', tmpdir(), 'sleep 30']);

    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));

    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    const authResult = await nextMessage(socket);
    expect(authResult).toMatchObject({ type: 'authResult', ok: true });

    socket.send(JSON.stringify({ type: 'list' }));
    const listed = await nextMessage(socket);
    expect(listed.type).toBe('workspaces');
    if (listed.type === 'workspaces') {
      expect(listed.workspaces.some((w) => w.id === name)).toBe(true);
    }

    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });

  it('serves a phone socket only through the Noise session, token check unchanged', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-phone-socket-'));
    dirs.push(home);
    const config = testConfig(home);
    const keys = generateAgentKeys();
    server = new WsServer(makeServerDeps(config, noClientLog));
    // Stands in for the phone port: a socket the agent did not accept on its own listener.
    const outside = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => outside.once('listening', r));
    const devices = {
      check: async () => ({ standing: 'unknown' as const, enrolment: 'on' as const }),
      enrol: async () => true,
      redeemPairing: async () => ({ redeemed: false as const }),
      burnPairing: async () => false,
    };
    outside.on('connection', (socket) =>
      server?.acceptPhoneSocket(wsFrameSocket(socket), b64url.decode(keys.x25519.privateKey), { devices }),
    );
    const url = `ws://127.0.0.1:${(outside.address() as AddressInfo).port}`;
    try {
      // Plaintext, even with the right token, is refused before anything is parsed.
      const plain = new WebSocket(url);
      await new Promise((r) => plain.once('open', r));
      const plainClosed = new Promise<number>((r) => plain.once('close', (code) => r(code)));
      plain.send(JSON.stringify({ type: 'auth', token: 'secret' }));
      expect(await plainClosed).toBe(4002);

      const stranger = await noiseClient(url, keys.x25519.publicKey);
      const strangerClosed = new Promise<void>((r) => stranger.socket.once('close', () => r()));
      stranger.send({ type: 'auth', token: 'wrong' });
      expect(await stranger.next()).toMatchObject({ type: 'authResult', ok: false });
      // The agent hangs up on a failed auth, freeing its unauthenticated slot.
      await strangerClosed;

      const client = await noiseClient(url, keys.x25519.publicKey);
      client.send({ type: 'auth', token: 'secret' });
      expect(await client.next()).toMatchObject({ type: 'authResult', ok: true });
      client.send({ type: 'list' });
      expect(((await client.next()) as { type: string }).type).toBe('workspaces');
      expect(((await client.next()) as { type: string }).type).toBe('browserSessions');

      // A media preview travels inside the session, chunk by acknowledged chunk.
      const png = new Uint8Array(150_000).map((_, i) => (i * 7) % 256);
      await writeFile(join(home, 'shot.png'), png);
      client.send({ type: 'readMedia', id: 'm1', path: join(home, 'shot.png') });
      expect(await client.next()).toEqual({ type: 'media', id: 'm1', result: 'ok', mediaType: 'image/png', size: png.length });
      const received: Buffer[] = [];
      let total = 0;
      while (total < png.length) {
        const chunk = (await client.next()) as { type: string; seq: number; data: string };
        expect(chunk.type).toBe('mediaChunk');
        received.push(Buffer.from(chunk.data, 'base64'));
        total += received.at(-1)!.length;
        client.send({ type: 'mediaAck', id: 'm1', seq: chunk.seq });
      }
      expect(new Uint8Array(Buffer.concat(received))).toEqual(png);
      client.socket.close();
    } finally {
      await new Promise((r) => outside.close(r));
    }
  });

  it('enrols a phone on its first token-authenticated IK session, and closes it once revoked', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-ik-'));
    dirs.push(home);
    const config = testConfig(home);
    const keys = generateAgentKeys();
    const store = new FileDeviceStore(config.devicesPath);
    const pairings = new FilePairingStore(config.pairingPath);
    const devices = new RosterDevices({ store, pairings, now: () => new Date(), onChange: () => undefined });
    server = new WsServer(makeServerDeps(config, noClientLog));
    const outside = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => outside.once('listening', r));
    outside.on('connection', (socket) =>
      server?.acceptPhoneSocket(wsFrameSocket(socket), b64url.decode(keys.x25519.privateKey), { devices }),
    );
    const url = `ws://127.0.0.1:${(outside.address() as AddressInfo).port}`;
    const phone = generateDeviceKeys();
    try {
      const first = await noiseClient(url, keys.x25519.publicKey, phone);
      first.send({ type: 'auth', token: 'secret' });
      // The answer waits for the roster: `enrolled` tells the phone it can forget the token.
      expect(await first.next()).toMatchObject({ type: 'authResult', ok: true, credential: 'token', enrolled: true });
      expect((await store.read()).devices.map((d) => d.x25519)).toEqual([phone.x25519.publicKey]);
      first.socket.close();

      // Sending the token again once enrolled is refused, so a phone that kept it drops it.
      const stale = await noiseClient(url, keys.x25519.publicKey, phone);
      const staleClosed = new Promise<[number, string]>((r) => stale.socket.once('close', (code, reason) => r([code, reason.toString()])));
      stale.send({ type: 'auth', token: 'secret' });
      expect(await staleClosed).toEqual([4003, 'token not needed']);

      const again = await noiseClient(url, keys.x25519.publicKey, phone);
      again.send({ type: 'auth', token: '' });
      expect(await again.next()).toMatchObject({ type: 'authResult', ok: true, credential: 'device', enrolled: true });
      const closed = new Promise<number>((r) => again.socket.once('close', (code) => r(code)));
      const roster = await store.update((r) => revokeDevice(r, r.devices[0]!.id, new Date()).roster);
      server.refuseRevokedDevices((key) => standingOf(roster, key) === 'revoked');
      expect(await closed).toBe(4003);

      const refused = new WebSocket(url);
      await new Promise((r) => refused.once('open', r));
      const refusedClosed = new Promise<number>((r) => refused.once('close', (code) => r(code)));
      const initiator = new IkInitiator(rawStaticKey(b64url.decode(phone.x25519.privateKey)), b64url.decode(keys.x25519.publicKey));
      refused.send(handshakeFrame(await initiator.writeMessage1(encodeDeviceHello({ sig: phone.ed25519.publicKey, name: 'p' })), 'ik'));
      expect(await refusedClosed).toBe(4003);

      // A second phone pairs with a one-time secret instead of the token, then reconnects with
      // no token at all: its enrolled key is what authenticates it.
      const secret = 's'.repeat(43);
      await pairings.update((list) => addPairing(list, secret, new Date()));
      const paired = generateDeviceKeys();
      const pairing = await noiseClient(url, keys.x25519.publicKey, paired);
      pairing.send({ type: 'auth', token: secret });
      expect(await pairing.next()).toMatchObject({ type: 'authResult', ok: true });
      await vi.waitFor(async () => expect((await store.read()).devices.map((d) => d.x25519)).toContain(paired.x25519.publicKey), LOADED_WAIT);
      expect((await pairings.read()).map((p) => p.usedAt !== undefined)).toEqual([true]);
      pairing.socket.close();
      const tokenless = await noiseClient(url, keys.x25519.publicKey, paired);
      tokenless.send({ type: 'auth', token: '' });
      expect(await tokenless.next()).toMatchObject({ type: 'authResult', ok: true });
      tokenless.socket.close();
      // The secret was single-use: a third phone presenting it is refused, and told why.
      const late = await noiseClient(url, keys.x25519.publicKey, generateDeviceKeys());
      const lateClosed = new Promise<[number, string]>((r) => late.socket.once('close', (code, reason) => r([code, reason.toString()])));
      late.send({ type: 'auth', token: secret });
      expect(await lateClosed).toEqual([4003, 'pairing code used']);

      // An enrolled device that opens a pairing link needs no code, but burns it: the link then
      // admits nobody else.
      const second = 't'.repeat(43);
      await pairings.update((list) => addPairing(list, second, new Date()));
      const enrolledAgain = await noiseClient(url, keys.x25519.publicKey, paired);
      enrolledAgain.send({ type: 'auth', token: second });
      expect(await enrolledAgain.next()).toMatchObject({ type: 'authResult', ok: true });
      enrolledAgain.socket.close();
      const stranger = await noiseClient(url, keys.x25519.publicKey, generateDeviceKeys());
      const strangerClosed = new Promise<[number, string]>((r) => stranger.socket.once('close', (code, reason) => r([code, reason.toString()])));
      stranger.send({ type: 'auth', token: second });
      expect(await strangerClosed).toEqual([4003, 'pairing code used']);

      // A phone without a device key (the retired NK handshake) is turned away before any reply.
      const nk = new WebSocket(url);
      await new Promise((r) => nk.once('open', r));
      const nkClosed = new Promise<number>((r) => nk.once('close', (code) => r(code)));
      nk.send(Uint8Array.of(0x02, ...new Uint8Array(48)));
      expect(await nkClosed).toBe(4002);
    } finally {
      await new Promise((r) => outside.close(r));
    }
  });

  it('tells every other connected phone when a device enrols', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-ik-'));
    dirs.push(home);
    const config = testConfig(home);
    const keys = generateAgentKeys();
    const store = new FileDeviceStore(config.devicesPath);
    const pairings = new FilePairingStore(config.pairingPath);
    const live = new WsServer(makeServerDeps(config, noClientLog));
    server = live;
    const devices = new RosterDevices({
      store,
      pairings,
      now: () => new Date(),
      onChange: () => undefined,
      onEnrolled: (device) => live.broadcastDeviceEnrolled(device),
    });
    const outside = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => outside.once('listening', r));
    outside.on('connection', (socket) => live.acceptPhoneSocket(wsFrameSocket(socket), b64url.decode(keys.x25519.privateKey), { devices }));
    const url = `ws://127.0.0.1:${(outside.address() as AddressInfo).port}`;
    try {
      const owner = await noiseClient(url, keys.x25519.publicKey, generateDeviceKeys());
      owner.send({ type: 'auth', token: 'secret' });
      expect(await owner.next()).toMatchObject({ type: 'authResult', ok: true, enrolled: true });

      const secret = 's'.repeat(43);
      await pairings.update((list) => addPairing(list, secret, new Date()));
      const added = generateDeviceKeys();
      const newcomer = await noiseClient(url, keys.x25519.publicKey, added);
      newcomer.send({ type: 'auth', token: secret });
      expect(await newcomer.next()).toMatchObject({ type: 'authResult', ok: true, enrolled: true });
      expect(await owner.next()).toMatchObject({ type: 'deviceEnrolled', id: deviceFingerprint(added.x25519.publicKey), name: 'test phone' });
      // The new phone is not told about itself.
      newcomer.send({ type: 'list' });
      expect(await newcomer.next()).toMatchObject({ type: 'workspaces' });
      owner.socket.close();
      newcomer.socket.close();
    } finally {
      await new Promise((r) => outside.close(r));
    }
  });

  it('delivers a hook-driven workspaceUpdated to a connected client', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-hook-'));
    dirs.push(home);
    const config = testConfig(home);
    server = new WsServer({
      config,
      hookToken: HOOK_TOKEN,
      tmux: new TmuxAdapter(),
      recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(),
      reader: new FsFileReader(),
      resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory,
      clock: systemClock,
      ids: new RandomIdGenerator(),
      pty: new NodePtyAdapter(),
      status: new InMemoryStatusStore(),
      writer: new FsFileWriter(),
      browserDiscovery: noBrowserDiscovery,
      browserCommands: noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog: noWorkspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
    });
    await server.start();
    const port = server.address().port;

    const name = `perch-${Date.now()}`;
    sessions.push(name);
    await exec('tmux', ['new-session', '-d', '-s', name, '-c', tmpdir(), 'sleep 30']);

    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket); // authResult

    const updated = new Promise<AgentMessage>((resolve) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as AgentMessage;
        if (msg.type === 'workspaceUpdated') resolve(msg);
      });
    });

    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer hook-secret' },
      body: JSON.stringify({ sessionName: name, event: 'Notification' }),
    });
    expect(res.status).toBe(204);

    const msg = await updated;
    expect(msg.type).toBe('workspaceUpdated');
    if (msg.type === 'workspaceUpdated') {
      expect(msg.workspace.id).toBe(name);
      expect(msg.workspace.status).toBe('needs-feedback');
    }

    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });

  it('does NOT flip to needs-feedback when Stop reports a running background task', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-bg-'));
    dirs.push(home);
    const config = testConfig(home);
    server = new WsServer({
      config,
      hookToken: HOOK_TOKEN,
      tmux: new TmuxAdapter(),
      recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(),
      reader: new FsFileReader(),
      resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory,
      clock: systemClock,
      ids: new RandomIdGenerator(),
      pty: new NodePtyAdapter(),
      status: new InMemoryStatusStore(),
      writer: new FsFileWriter(),
      browserDiscovery: noBrowserDiscovery,
      browserCommands: noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog: noWorkspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
    });
    await server.start();
    const port = server.address().port;

    const name = `perch-${Date.now()}`;
    sessions.push(name);
    await exec('tmux', ['new-session', '-d', '-s', name, '-c', tmpdir(), 'sleep 30']);

    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket); // authResult

    let broadcast = false;
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as AgentMessage;
      if (msg.type === 'workspaceUpdated') broadcast = true;
    });

    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer hook-secret' },
      body: JSON.stringify({
        sessionName: name,
        event: 'Stop',
        claude: { background_tasks: [{ id: 'b00000001', type: 'shell', status: 'running' }] },
      }),
    });
    expect(res.status).toBe(204);

    await new Promise((r) => setTimeout(r, 300));
    expect(broadcast).toBe(false);

    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });

  it('does NOT broadcast a hook-driven update for a workspace under a hidden folder', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-hidden-'));
    dirs.push(home);
    const projectDir = join(home, 'secret-proj');
    await mkdir(projectDir);
    const config = testConfig(home, { projectRoots: [home] });
    server = new WsServer({
      config,
      hookToken: HOOK_TOKEN,
      tmux: new TmuxAdapter(),
      recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(),
      reader: new FsFileReader(),
      resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory,
      clock: systemClock,
      ids: new RandomIdGenerator(),
      pty: new NodePtyAdapter(),
      status: new InMemoryStatusStore(),
      writer: new FsFileWriter(),
      browserDiscovery: noBrowserDiscovery,
      browserCommands: noBrowserCommands,
      hiddenFolders: { list: async () => ['secret-proj'] },
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog: noWorkspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
    });
    await server.start();
    const port = server.address().port;

    const name = `perch-${Date.now()}`;
    sessions.push(name);
    await exec('tmux', ['new-session', '-d', '-s', name, '-c', projectDir, 'sleep 30']);

    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket); // authResult

    let broadcast = false;
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as AgentMessage;
      if (msg.type === 'workspaceUpdated') broadcast = true;
    });

    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer hook-secret' },
      body: JSON.stringify({ sessionName: name, event: 'Notification' }),
    });
    expect(res.status).toBe(204);

    await new Promise((r) => setTimeout(r, 300));
    expect(broadcast).toBe(false);

    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });

  it('delivers a setStatus-driven workspaceUpdated to a connected client', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-block-'));
    dirs.push(home);
    const config = testConfig(home);
    server = new WsServer({
      config,
      hookToken: HOOK_TOKEN,
      tmux: new TmuxAdapter(),
      recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(),
      reader: new FsFileReader(),
      resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory,
      clock: systemClock,
      ids: new RandomIdGenerator(),
      pty: new NodePtyAdapter(),
      status: new InMemoryStatusStore(),
      writer: new FsFileWriter(),
      browserDiscovery: noBrowserDiscovery,
      browserCommands: noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog: noWorkspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
    });
    await server.start();
    const port = server.address().port;

    const name = `perch-${Date.now()}-block`;
    sessions.push(name);
    await exec('tmux', ['new-session', '-d', '-s', name, '-c', tmpdir(), 'sleep 30']);

    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket); // authResult

    const updated = new Promise<AgentMessage>((resolve) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as AgentMessage;
        if (msg.type === 'workspaceUpdated' && msg.workspace.id === name) resolve(msg);
      });
    });

    socket.send(JSON.stringify({ type: 'setStatus', workspaceId: name, status: 'blocked' }));

    const msg = await updated;
    expect(msg.type).toBe('workspaceUpdated');
    if (msg.type === 'workspaceUpdated') {
      expect(msg.workspace.id).toBe(name);
      expect(msg.workspace.status).toBe('blocked');
    }

    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });

  it('polls tmux and pushes a workspaceUpdated when a pane title changes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-title-'));
    dirs.push(home);
    const config = testConfig(home);
    const polls = pollTicks();
    server = new WsServer({
      config,
      hookToken: HOOK_TOKEN,
      tmux: new TmuxAdapter(),
      recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(),
      reader: new FsFileReader(),
      resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory,
      clock: systemClock,
      ids: new RandomIdGenerator(),
      pty: new NodePtyAdapter(),
      status: new InMemoryStatusStore(),
      writer: new FsFileWriter(),
      browserDiscovery: noBrowserDiscovery,
      browserCommands: noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog: noWorkspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
      titlePollMs: 50,
      onPollTick: polls.onPollTick,
    });
    await server.start();
    const port = server.address().port;

    const name = `perch-${Date.now()}-title`;
    sessions.push(name);
    await exec('tmux', ['new-session', '-d', '-s', name, '-c', tmpdir(), 'sleep 30']);

    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket); // authResult

    const renamed = new Promise<AgentMessage>((resolve) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as AgentMessage;
        if (msg.type === 'workspaceUpdated' && msg.workspace.id === name && msg.workspace.name === 'fresh title') {
          resolve(msg);
        }
      });
    });

    // Let the poller record the session's initial (hostname-derived) name first.
    await polls.after(2);
    await exec('tmux', ['select-pane', '-t', name, '-T', '✳ fresh title']);

    const msg = await renamed;
    expect(msg.type).toBe('workspaceUpdated');
    if (msg.type === 'workspaceUpdated') {
      expect(msg.workspace.name).toBe('fresh title');
    }

    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });

  it('pushes a workspace whose pane starts or stops showing a question', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-asking-'));
    dirs.push(home);
    const config = testConfig(home);
    let state = 'working';
    const tmux: TmuxPort = {
      listSessions: async () => [
        { name: 'perch-ask', startPath: tmpdir(), command: 'claude', createdAt: 1, title: '', program: { state, changedAt: state === 'working' ? 1 : 2 } },
      ],
      createSession: async () => undefined,
      killSession: async () => undefined,
      hasSession: async () => true,
    };
    server = new WsServer({
      config,
      hookToken: HOOK_TOKEN,
      tmux,
      recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(),
      reader: new FsFileReader(),
      resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory,
      clock: systemClock,
      ids: new RandomIdGenerator(),
      pty: new NodePtyAdapter(),
      status: new InMemoryStatusStore(),
      writer: new FsFileWriter(),
      browserDiscovery: noBrowserDiscovery,
      browserCommands: noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog: noWorkspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
      titlePollMs: 50,
    });
    await server.start();
    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket); // authResult
    const updates: boolean[] = [];
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as AgentMessage;
      if (msg.type === 'workspaceUpdated' && msg.workspace.id === 'perch-ask') updates.push(msg.workspace.asking ?? false);
    });
    await new Promise((r) => setTimeout(r, 200));
    state = 'blocked';
    await vi.waitFor(() => expect(updates).toContain(true));
    state = 'idle';
    await vi.waitFor(() => expect(updates.at(-1)).toBe(false));
    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });

  it('polls tmux and pushes a closed when a session disappears', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-gone-'));
    dirs.push(home);
    const config = testConfig(home);
    const workspaceLogged: WorkspaceLogEntry[] = [];
    const workspaceLog: WorkspaceLogPort = { append: async (e) => void workspaceLogged.push(e) };
    const polls = pollTicks();
    server = new WsServer({
      config,
      hookToken: HOOK_TOKEN,
      tmux: new TmuxAdapter(),
      recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(),
      reader: new FsFileReader(),
      resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory,
      clock: systemClock,
      ids: new RandomIdGenerator(),
      pty: new NodePtyAdapter(),
      status: new InMemoryStatusStore(),
      writer: new FsFileWriter(),
      browserDiscovery: noBrowserDiscovery,
      browserCommands: noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
      titlePollMs: 50,
      onPollTick: polls.onPollTick,
    });
    await server.start();
    const port = server.address().port;

    const name = `perch-${Date.now()}-gone`;
    sessions.push(name);
    await exec('tmux', ['new-session', '-d', '-s', name, '-c', tmpdir(), 'sleep 30']);

    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket); // authResult

    const closed = new Promise<AgentMessage>((resolve) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as AgentMessage;
        if (msg.type === 'closed' && msg.workspaceId === name) resolve(msg);
      });
    });

    // Let the poller record the session as present first, then kill it out from under
    // the agent (as happens when the inner Claude process exits and tmux destroys it).
    await polls.after(2);
    await exec('tmux', ['kill-session', '-t', name]);

    const msg = await closed;
    expect(msg.type).toBe('closed');
    if (msg.type === 'closed') {
      expect(msg.workspaceId).toBe(name);
    }
    // The poll pushes the close before it writes the log entry.
    await vi.waitFor(() => {
      expect(workspaceLogged).toEqual([
        expect.objectContaining({ id: name, projectPath: tmpdir(), reason: 'exited' }),
      ]);
    }, LOADED_WAIT);

    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });

  it('broadcasts closed to every connected device on an explicit close, and logs exactly one entry', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-explicit-close-'));
    dirs.push(home);
    const config = testConfig(home);
    const workspaceLogged: WorkspaceLogEntry[] = [];
    const workspaceLog: WorkspaceLogPort = { append: async (e) => void workspaceLogged.push(e) };
    const polls = pollTicks();
    server = new WsServer({
      config,
      hookToken: HOOK_TOKEN,
      tmux: new TmuxAdapter(),
      recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(),
      reader: new FsFileReader(),
      resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory,
      clock: systemClock,
      ids: new RandomIdGenerator(),
      pty: new NodePtyAdapter(),
      status: new InMemoryStatusStore(),
      writer: new FsFileWriter(),
      browserDiscovery: noBrowserDiscovery,
      browserCommands: noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
      // A coarser interval than the other polling tests here (50ms): this test's race is
      // *with the poll itself* (forgetWorkspace's synchronous map removal racing the async
      // tmux kill it precedes — the accepted "narrow double-log race"), so a tight
      // interval makes the accepted, documented race far likelier to fire and flake this
      // test. A wider gap leaves a comfortable margin around the close for the real
      // tmux-kill subprocess to finish well clear of the neighbouring poll ticks.
      titlePollMs: 400,
      onPollTick: polls.onPollTick,
    });
    await server.start();
    const port = server.address().port;

    const name = `perch-${Date.now()}-explicit`;
    sessions.push(name);
    await exec('tmux', ['new-session', '-d', '-s', name, '-c', tmpdir(), 'sleep 30']);

    const closer = new WebSocket(await clientUrl());
    await new Promise((r) => closer.once('open', r));
    closer.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(closer); // authResult

    const observer = new WebSocket(await clientUrl());
    await new Promise((r) => observer.once('open', r));
    observer.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(observer); // authResult

    // Let the poller record the session as present before closing it.
    await polls.after(2);

    const observerClosed = new Promise<AgentMessage>((resolve) => {
      observer.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as AgentMessage;
        if (msg.type === 'closed' && msg.workspaceId === name) resolve(msg);
      });
    });

    closer.send(JSON.stringify({ type: 'close', workspaceId: name }));
    await nextMessage(closer); // the requester's own `closed` reply

    const msg = await observerClosed; // the OTHER device must also get it
    expect(msg.type).toBe('closed');

    // Let polls run once tmux no longer lists the session and confirm no duplicate 'exited' entry appears.
    await polls.after(3);
    expect(workspaceLogged.filter((e) => e.id === name)).toEqual([
      expect.objectContaining({ id: name, reason: 'closed-by-user' }),
    ]);

    for (const s of [closer, observer]) {
      await new Promise<void>((resolve) => {
        s.on('close', () => resolve());
        s.close();
      });
    }
  });

  it('records each accepted hook event in the hook-event log', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-hooklog-'));
    dirs.push(home);
    const config = testConfig(home);
    const entries: HookEventEntry[] = [];
    server = new WsServer({
      ...makeServerDeps(config, noClientLog),
      hookEventLog: { append: async (e) => void entries.push(e) },
    });
    await server.start();
    const res = await fetch(`http://127.0.0.1:${server.address().port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer hook-secret' },
      body: JSON.stringify({ sessionName: 'perch-x', event: 'StopFailure', claude: { error: 'overloaded' } }),
    });
    expect(res.status).toBe(204);
    expect(entries).toMatchObject([
      { workspace: 'perch-x', event: 'StopFailure', error: 'overloaded', reason: 'stop-failure', after: { status: 'needs-feedback' } },
    ]);
  });

  // `perch unpark` asks the running agent: it owns status.json in memory and writes parked.json,
  // so a CLI writing either itself would race it.
  it('unparks a workspace over POST /unpark, restoring its name', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-unpark-'));
    dirs.push(home);
    const config = testConfig(home);
    const name = `perch-unpark${process.pid}`;
    sessions.push(name);
    const deps = makeServerDeps(config, noClientLog);
    await deps.parked.add({
      id: name, name: 'audit workflows #1077', projectPath: tmpdir(), command: 'sleep 30',
      machineId: 'test', createdAt: 1, parkedAt: 2, parent: 'perch-orch',
    });
    deps.status.set(name, 'parked');
    server = new WsServer(deps);
    await server.start();
    const post = (body: unknown, token = HOOK_TOKEN) =>
      fetch(`http://127.0.0.1:${server!.address().port}/unpark`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });

    expect((await post({ id: name }, 'wrong')).status).toBe(401);
    expect((await post({ nope: 1 })).status).toBe(400);
    const res = await post({ id: name });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'unparked' });
    expect(await deps.parked.get(name)).toBeUndefined();
    expect(deps.status.get(name)).toBe('idle');
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', name, '#{pane_title}|#{@perch_parent}']);
    expect(stdout.trim()).toBe('✳ audit workflows #1077|perch-orch');
    expect(await (await post({ id: name })).json()).toEqual({ result: 'not-parked' });
  });

  it('rejects a /hooks POST without the bearer token', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-hook401-'));
    dirs.push(home);
    const config = testConfig(home);
    server = new WsServer({
      config, hookToken: HOOK_TOKEN, tmux: new TmuxAdapter(), recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(), reader: new FsFileReader(), resolvePath: systemPathResolver, isDirectory: fsIsDirectory, clock: systemClock,
      ids: new RandomIdGenerator(), pty: new NodePtyAdapter(), status: new InMemoryStatusStore(),
      writer: new FsFileWriter(),
      browserDiscovery: noBrowserDiscovery,
      browserCommands: noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog: noWorkspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
    });
    await server.start();
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionName: 'perch-x', event: 'Stop' }),
    });
    expect(res.status).toBe(401);
    const wrong = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secreT' },
      body: JSON.stringify({ sessionName: 'perch-x', event: 'Stop' }),
    });
    expect(wrong.status).toBe(401);
    // PERCH_TOKEN enrols phones; a hook leaking its secret must not leak that one, so it is no
    // hooks credential.
    const machineToken = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ sessionName: 'perch-x', event: 'Stop' }),
    });
    expect(machineToken.status).toBe(401);
    // A hook body is a few kilobytes; anything past the cap is refused, not buffered.
    const huge = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer hook-secret' },
      body: JSON.stringify({ sessionName: 'perch-x', event: 'Stop', claude: { pad: 'x'.repeat(HOOK_BODY_MAX_BYTES) } }),
    }).catch(() => null);
    expect(huge === null || huge.status === 413).toBe(true);
  });

  it('rejects a bad token', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-srv-'));
    dirs.push(home);
    const config = testConfig(home);
    server = new WsServer({
      config,
      hookToken: HOOK_TOKEN,
      tmux: new TmuxAdapter(),
      recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(),
      reader: new FsFileReader(),
      resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory,
      clock: systemClock,
      ids: new RandomIdGenerator(),
      pty: new NodePtyAdapter(),
      status: new InMemoryStatusStore(),
      writer: new FsFileWriter(),
      browserDiscovery: noBrowserDiscovery,
      browserCommands: noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog: noWorkspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
    });
    await server.start();
    const port = server.address().port;

    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    const authResult = await nextMessage(socket);
    expect(authResult).toEqual({ type: 'authResult', ok: false });
    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });

  // The bug the fake-agent E2E could never catch: a session emits an OSC 8 hyperlink, and
  // it must reach the client THROUGH a real `tmux attach-session`. tmux's default
  // terminal-features for xterm* omits `hyperlinks`, so it strips the link to plain text
  // unless the agent enables passthrough on attach. We reset terminal-features to baseline
  // first so this test has teeth: without ConnectionHandler's ensureHyperlinks() the
  // assertion fails (the OSC 8 introducer never arrives).
  it('streams OSC 8 hyperlinks through a real tmux attach', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-osc8-'));
    dirs.push(home);
    const config = testConfig(home);
    server = new WsServer({
      config, hookToken: HOOK_TOKEN, tmux: new TmuxAdapter(), recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(), reader: new FsFileReader(), resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory, clock: systemClock,
      ids: new RandomIdGenerator(), pty: new NodePtyAdapter(), status: new InMemoryStatusStore(),
      writer: new FsFileWriter(),
      browserDiscovery: noBrowserDiscovery,
      browserCommands: noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog: noWorkspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
    });
    await server.start();
    const port = server.address().port;

    const name = `perch-${Date.now()}-osc8`;
    sessions.push(name);
    // A pane that prints an OSC 8 hyperlink and stays alive so the attach redraws it.
    const script =
      "printf '\\033]8;;%s\\033\\\\%s\\033]8;;\\033\\\\\\n' 'https://ex.com/HL' 'OSC8LINK'; sleep 30";
    await exec('tmux', ['new-session', '-d', '-s', name, '-x', '120', '-y', '30', '-c', tmpdir(), 'bash', '-c', script]);
    // Baseline: strip the hyperlinks feature so only the agent's attach can re-enable it.
    await exec('tmux', ['set', '-ug', 'terminal-features']).catch(() => undefined);

    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket); // authResult

    let stream = '';
    const needle = '\x1b]8;;'; // OSC 8 introducer
    const seen = new Promise<void>((resolve) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as AgentMessage;
        if (msg.type === 'output' && msg.workspaceId === name) {
          stream += Buffer.from(msg.data, 'base64').toString('utf8');
          if (stream.includes(needle)) resolve();
        }
      });
    });
    socket.send(JSON.stringify({ type: 'attach', workspaceId: name, cols: 120, rows: 30 }));

    await Promise.race([
      seen,
      new Promise((_r, reject) => setTimeout(() => reject(new Error('no OSC 8 link in stream')), 5000)),
    ]);
    expect(stream).toContain(needle);
    expect(stream).toContain('https://ex.com/HL');

    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });

  it('parks a workspace (killing tmux, keeping it listed) and reopens it on attach', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-park-'));
    dirs.push(home);
    const config = testConfig(home);
    const logged: WorkspaceLogEntry[] = [];
    const workspaceLog: WorkspaceLogPort = { append: async (e) => void logged.push(e) };
    const status = new InMemoryStatusStore();
    server = new WsServer({
      config,
      hookToken: HOOK_TOKEN,
      tmux: new TmuxAdapter(),
      recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(),
      reader: new FsFileReader(),
      resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory,
      clock: systemClock,
      ids: new RandomIdGenerator(),
      pty: new NodePtyAdapter(),
      status,
      writer: new FsFileWriter(),
      browserDiscovery: noBrowserDiscovery,
      browserCommands: noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
    });
    await server.start();
    const port = server.address().port;

    const name = `perch-${Date.now()}-park`;
    sessions.push(name);
    // `@perch_command` mirrors what TmuxAdapter.createSession sets on a real workspace —
    // FileParkedStore.list() drops any entry with an empty `command` field, so a parked
    // record for a session missing this option is silently unparseable.
    await exec('tmux', ['new-session', '-d', '-s', name, '-c', tmpdir(), 'sleep 300']);
    await exec('tmux', ['set-option', '-t', name, '@perch_command', 'sleep 300']);

    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket); // authResult

    const tmux = new TmuxAdapter();

    // Parking requires a resumable conversation. A real workspace gets this from the first
    // Claude Code hook event; stamp it directly so the test does not depend on hook wiring.
    status.setClaudeSessionId(name, 'sess-e2e');

    // Park it.
    socket.send(JSON.stringify({ type: 'setStatus', workspaceId: name, status: 'parked' }));
    await vi.waitFor(async () => {
      expect(await tmux.hasSession(name)).toBe(false);
    }, LOADED_WAIT);

    // Still listed as parked — the PWA sees no gap, and parking is not a close.
    socket.send(JSON.stringify({ type: 'list' }));
    // The park's own workspaceUpdated can still be in flight once tmux has dropped the session.
    const listed = await replyOfType(socket, 'workspaces');
    expect(listed.workspaces.find((w) => w.id === name)).toMatchObject({ status: 'parked' });
    expect(logged.find((e) => e.id === name)).toBeUndefined();

    // Reopening recreates the session.
    socket.send(JSON.stringify({ type: 'attach', workspaceId: name, cols: 80, rows: 24 }));
    await vi.waitFor(async () => {
      expect(await tmux.hasSession(name)).toBe(true);
    }, LOADED_WAIT);
    // unparkWorkspace creates the session before clearing the record, so hasSession can
    // flip true a moment before the parked-store write lands — poll this too rather than
    // reading the file exactly once.
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(config.parkedStorePath, 'utf8'))).toEqual([]);
    }, LOADED_WAIT);

    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });

  it('parks a continuum-restored session (no @perch_command) when a claude session id is known', async () => {
    // tmux-continuum restores sessions after a reboot but does not restore custom session
    // options, so a continuum-revived workspace has an empty `@perch_command`/command even
    // though it is a live, resumable Claude session (its id lives in the status store, set
    // by a prior hook event).
    const home = await mkdtemp(join(tmpdir(), 'perch-park-continuum-'));
    dirs.push(home);
    const config = testConfig(home);
    const status = new InMemoryStatusStore();
    server = new WsServer({
      config,
      hookToken: HOOK_TOKEN,
      tmux: new TmuxAdapter(),
      recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(),
      reader: new FsFileReader(),
      resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory,
      clock: systemClock,
      ids: new RandomIdGenerator(),
      pty: new NodePtyAdapter(),
      status,
      writer: new FsFileWriter(),
      browserDiscovery: noBrowserDiscovery,
      browserCommands: noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog: noWorkspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
    });
    await server.start();
    const port = server.address().port;

    const name = `perch-${Date.now()}-continuum`;
    sessions.push(name);
    // No `@perch_command` set — this is what a continuum-restored session looks like.
    await exec('tmux', ['new-session', '-d', '-s', name, '-c', tmpdir(), 'sleep 300']);
    status.setClaudeSessionId(name, 'sess-continuum');

    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket); // authResult

    const tmux = new TmuxAdapter();
    socket.send(JSON.stringify({ type: 'setStatus', workspaceId: name, status: 'parked' }));
    await vi.waitFor(async () => {
      expect(await tmux.hasSession(name)).toBe(false);
    }, LOADED_WAIT);

    const parked = JSON.parse(await readFile(config.parkedStorePath, 'utf8')) as Array<{ id: string; command: string }>;
    expect(parked).toHaveLength(1);
    expect(parked[0]?.command).toBe('claude');

    socket.send(JSON.stringify({ type: 'list' }));
    // The park's own workspaceUpdated can still be in flight once tmux has dropped the session.
    const listed = await replyOfType(socket, 'workspaces');
    expect(listed.workspaces.find((w) => w.id === name)).toMatchObject({ status: 'parked' });

    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });

  it('refuses to park a continuum-restored session (no @perch_command, no known session id), leaving it alive', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-park-continuum-refused-'));
    dirs.push(home);
    const config = testConfig(home);
    server = new WsServer({
      config,
      hookToken: HOOK_TOKEN,
      tmux: new TmuxAdapter(),
      recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(),
      reader: new FsFileReader(),
      resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory,
      clock: systemClock,
      ids: new RandomIdGenerator(),
      pty: new NodePtyAdapter(),
      status: new InMemoryStatusStore(),
      writer: new FsFileWriter(),
      browserDiscovery: noBrowserDiscovery,
      browserCommands: noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog: noWorkspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
    });
    await server.start();
    const port = server.address().port;

    const name = `perch-${Date.now()}-continuum-refused`;
    sessions.push(name);
    // No `@perch_command`, and no session id was ever recorded either — nothing to restore.
    await exec('tmux', ['new-session', '-d', '-s', name, '-c', tmpdir(), 'sleep 300']);

    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket); // authResult

    socket.send(JSON.stringify({ type: 'setStatus', workspaceId: name, status: 'parked' }));
    const errorMsg = await nextMessage(socket);
    expect(errorMsg).toMatchObject({ type: 'error', code: 'not-restorable' });

    const tmux = new TmuxAdapter();
    expect(await tmux.hasSession(name)).toBe(true);
    expect(JSON.parse(await readFile(config.parkedStorePath, 'utf8').catch(() => '[]'))).toEqual([]);

    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });

  it('does NOT log or broadcast a close for a parked workspace once its session disappears', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-park-poll-'));
    dirs.push(home);
    const config = testConfig(home);
    const logged: WorkspaceLogEntry[] = [];
    const workspaceLog: WorkspaceLogPort = { append: async (e) => void logged.push(e) };
    const polls = pollTicks();
    server = new WsServer({
      config,
      hookToken: HOOK_TOKEN,
      tmux: new TmuxAdapter(),
      recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(),
      reader: new FsFileReader(),
      resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory,
      clock: systemClock,
      ids: new RandomIdGenerator(),
      pty: new NodePtyAdapter(),
      status: new InMemoryStatusStore(),
      writer: new FsFileWriter(),
      browserDiscovery: noBrowserDiscovery,
      browserCommands: noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
      titlePollMs: 50,
      onPollTick: polls.onPollTick,
    });
    await server.start();
    const port = server.address().port;

    const name = `perch-${Date.now()}-park-poll`;
    sessions.push(name);
    await exec('tmux', ['new-session', '-d', '-s', name, '-c', tmpdir(), 'sleep 300']);

    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket); // authResult

    const closedForParked: string[] = [];
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as AgentMessage;
      if (msg.type === 'closed' && msg.workspaceId === name) closedForParked.push(msg.workspaceId);
    });

    // Let the poller record the session as present first, so the id is already tracked in
    // WsServer's internal `lastWorkspaces` map when it disappears below — exactly the
    // precondition the disappearance-detection loop needs to fire.
    await polls.after(2);

    // Land the workspace directly in the settled post-park state (a parked record on disk,
    // no tmux session) instead of going through the WS `setStatus: 'parked'` flow. That
    // flow's own `forgetWorkspace` call pre-emptively removes the id from `lastWorkspaces`
    // before parkWorkspace ever kills the session, so in the common case the poll never
    // gets a chance to observe a disappearance at all — the `parked: this.deps.parked`
    // protection only matters for a narrow, timing-dependent race (an in-flight poll
    // re-adding the id just before the kill lands; see the accepted-race comment on
    // `WsServer.forgetWorkspace`). Building the settled state directly exercises the
    // protection deterministically, independent of that race.
    await new FileParkedStore(config.parkedStorePath).add({
      id: name,
      name: 'parked test workspace',
      projectPath: tmpdir(),
      command: 'sleep 300',
      machineId: 'test',
      createdAt: Date.now(),
      parkedAt: Date.now(),
    });
    await exec('tmux', ['kill-session', '-t', name]);

    // Absence can't be `vi.waitFor`'d: wait for whole poll ticks against the settled state.
    await polls.after(3);
    expect(logged.find((e) => e.id === name)).toBeUndefined();

    // Anything those ticks pushed reaches the socket before this reply does.
    socket.send(JSON.stringify({ type: 'list' }));
    const listed = await replyOfType(socket, 'workspaces');
    expect(listed.workspaces.find((w) => w.id === name)).toMatchObject({ status: 'parked' });
    expect(closedForParked).toEqual([]);

    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });
});

describe('WsServer listener', () => {
  // Phones come through the phone port: the hooks listener is loopback only, and it answers nothing a phone used to ask for.
  it('listens on loopback only, and serves no WebSocket and no phone endpoint', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-listener-'));
    dirs.push(home);
    const config = testConfig(home);
    server = new WsServer(makeServerDeps(config, noClientLog));
    await server.start();
    const port = server.address().port;
    expect((server as unknown as { http: { address(): AddressInfo } }).http.address().address).toBe('127.0.0.1');

    const auth = { authorization: 'Bearer hook-secret' };
    expect((await fetch(`http://127.0.0.1:${port}/file?path=/etc/hostname`, { headers: auth })).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/clientlog`, { method: 'POST', headers: auth, body: '{}' })).status).toBe(404);
    for (const path of ['/', '/browser?session=x']) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      const opened = await new Promise<boolean>((resolve) => {
        socket.once('open', () => resolve(true));
        socket.once('error', () => resolve(false));
      });
      expect(opened).toBe(false);
    }
    const hook = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionName: 'perch-x', event: 'Stop' }),
    });
    expect(hook.status).toBe(204);
  });
});

describe('WsServer hooks route', () => {
  // The route must hand the hook's `agent` on: without it a Codex session id is recorded as a
  // Claude one, and the workspace becomes parkable with nothing `claude --resume` can open.
  it('records a Claude session id but not a Codex one', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-hook-agent-'));
    dirs.push(home);
    const deps = makeServerDeps(testConfig(home), noClientLog);
    server = new WsServer(deps);
    await server.start();
    const port = server.address().port;
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/hooks`, {
        method: 'POST',
        headers: { authorization: 'Bearer hook-secret', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect(
      (await post({ sessionName: 'perch-codex', event: 'Stop', agent: 'codex', claude: { session_id: 'c1' } })).status,
    ).toBe(204);
    expect((await post({ sessionName: 'perch-claude', event: 'Stop', claude: { session_id: 'k1' } })).status).toBe(204);
    expect(deps.status.getClaudeSessionId('perch-codex')).toBeUndefined();
    expect(deps.status.getClaudeSessionId('perch-claude')).toBe('k1');
  });
});

// `waitingOn` is derived from the in-memory SendMessage mark, which changes without the status
// changing (a child is `working` before and after it messages its orchestrator), so the status
// store's onChange cannot be what tells the phone.
describe('WsServer waiting-on-parent push', () => {
  const sockets: WebSocket[] = [];
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });

  it('pushes the workspace when the SendMessage mark flips while the status stays working', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-waiting-'));
    dirs.push(home);
    const tmux: TmuxPort = {
      listSessions: async () => [
        { name: 'perch-child', startPath: tmpdir(), command: 'claude', createdAt: 1000, parent: 'perch-p', title: '' },
      ],
      createSession: async () => undefined,
      killSession: async () => undefined,
      hasSession: async () => true,
    };
    const status = new InMemoryStatusStore();
    status.set('perch-child', 'working');
    server = new WsServer({ ...makeServerDeps(testConfig(home), noClientLog), tmux, status });
    await server.start();
    const port = server.address().port;

    const socket = new WebSocket(await clientUrl());
    sockets.push(socket);
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket);
    const updates: Array<Extract<AgentMessage, { type: 'workspaceUpdated' }>['workspace']> = [];
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as AgentMessage;
      if (msg.type === 'workspaceUpdated') updates.push(msg.workspace);
    });
    const post = (tool: string) =>
      fetch(`http://127.0.0.1:${port}/hooks`, {
        method: 'POST',
        headers: { authorization: `Bearer ${HOOK_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionName: 'perch-child', event: 'PostToolUse', claude: { tool_name: tool } }),
      });
    const until = async (n: number) => {
      const deadline = Date.now() + 3000;
      while (updates.length < n) {
        if (Date.now() > deadline) throw new Error(`expected ${n} updates, got ${updates.length}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    await post('SendMessage');
    await until(1);
    expect(status.getMessagedLast('perch-child')).toBe(true);
    expect(updates[0]).toMatchObject({ id: 'perch-child', status: 'working', parentId: 'perch-p', waitingOn: 'parent' });

    await post('Bash');
    await until(2);
    expect(status.getMessagedLast('perch-child')).toBe(false);
    expect(updates[1]).toMatchObject({ id: 'perch-child', status: 'working', parentId: 'perch-p' });
    expect(updates[1]).not.toHaveProperty('waitingOn');

    // A tool call that leaves the mark and the status as they were pushes nothing.
    await post('Read');
    await new Promise((r) => setTimeout(r, 100));
    expect(updates).toHaveLength(2);
  });

  // A fake tmux the poll reads, a connected client, and what reaches the log and the client.
  async function pollingServer() {
    const home = await mkdtemp(join(tmpdir(), 'perch-closing-'));
    dirs.push(home);
    let title: string | null = '';
    const tmux: TmuxPort = {
      listSessions: async () =>
        title === null ? [] : [{ name: 'perch-x', startPath: tmpdir(), command: 'claude', createdAt: 1000, title }],
      createSession: async () => undefined,
      killSession: async () => undefined,
      hasSession: async () => title !== null,
    };
    const clock = { t: 1_000_000, now() { return this.t; } };
    const logged: string[] = [];
    const closed: string[] = [];
    const names: string[] = [];
    const status = new InMemoryStatusStore();
    const polls = pollTicks();
    const s = new WsServer({
      ...makeServerDeps(testConfig(home), noClientLog),
      tmux,
      clock,
      status,
      workspaceLog: { append: async (e) => void logged.push(`${e.id}:${e.reason}`) },
      titlePollMs: 20,
      onPollTick: polls.onPollTick,
    });
    server = s;
    await s.start();
    const socket = new WebSocket(await clientUrl());
    sockets.push(socket);
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket);
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as AgentMessage;
      if (msg.type === 'closed') closed.push(msg.workspaceId);
      if (msg.type === 'workspaceUpdated' && msg.workspace.id === 'perch-x') names.push(msg.workspace.name);
    });
    // A whole poll tick, then a round trip, so whatever that tick pushed has reached the client.
    const ticks = async () => {
      await polls.after(2);
      socket.send(JSON.stringify({ type: 'list' }));
      await replyOfType(socket, 'workspaces');
    };
    await ticks();
    return {
      server: s,
      status,
      ticks,
      clock,
      logged,
      closed,
      names,
      // null = tmux no longer lists the session.
      setTitle: (next: string | null) => void (title = next),
    };
  }

  // An explicit close forgets the workspace before its tmux kill completes. A poll that still
  // lists the session in that gap must not take it back, or the workspace is logged a second
  // time as `exited` (and pushed closed again) once the kill lands.
  it('does not take back a workspace that is being closed while tmux still lists it', async () => {
    const s = await pollingServer();
    expect(s.server.forgetWorkspace('perch-x', true)).toMatchObject({ id: 'perch-x' });
    await s.ticks();
    s.setTitle(null);
    await s.ticks();
    expect(s.logged).toEqual([]);
    expect(s.closed).toEqual([]);
  });

  // Parking forgets the workspace too, but its parked record keeps it listed, and unparking
  // brings the same id back live: the poll must go on following it.
  it('goes on following a workspace forgotten by a park, after it is unparked', async () => {
    const s = await pollingServer();
    s.server.forgetWorkspace('perch-x');
    await s.ticks();
    s.setTitle('✳ renamed');
    await s.ticks();
    expect(s.names).toContain('renamed');
    s.setTitle(null);
    await s.ticks();
    expect(s.logged).toEqual(['perch-x:exited']);
    expect(s.closed).toEqual(['perch-x']);
  });

  // Ids are reused, so the next workspace to take this one must not inherit its Claude session id.
  it('forgets the status entry of a workspace that exited, once it is logged', async () => {
    const s = await pollingServer();
    s.status.set('perch-x', 'working');
    s.status.setClaudeSessionId('perch-x', 'old-session');
    s.setTitle(null);
    await s.ticks();
    expect(s.logged).toEqual(['perch-x:exited']);
    expect(s.status.ids()).toEqual([]);
  });

  // The title poll runs only while a phone is connected; a number must still come free without one.
  it('forgets the state of a gone workspace with no phone connected, and keeps live and parked ones', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-gone-'));
    dirs.push(home);
    const status = new InMemoryStatusStore();
    status.set('perch-gone', 'working');
    status.set('perch-live', 'working');
    status.set('perch-parked', 'parked');
    const tmux: TmuxPort = {
      listSessions: async () => [{ name: 'perch-live', startPath: tmpdir(), command: 'claude', createdAt: 1, title: '' }],
      createSession: async () => undefined,
      killSession: async () => undefined,
      hasSession: async (name) => name === 'perch-live',
    };
    const config = testConfig(home);
    const parked = new FileParkedStore(config.parkedStorePath);
    await parked.add({ id: 'perch-parked', name: 'p', projectPath: tmpdir(), command: 'claude', machineId: 'm', createdAt: 1, parkedAt: 2, claudeSessionId: 's' });
    const polls = pollTicks();
    server = new WsServer({ ...makeServerDeps(config, noClientLog), tmux, status, parked, titlePollMs: 20, onPollTick: polls.onPollTick });
    await server.start();
    await polls.after(2);
    expect(status.ids().sort()).toEqual(['perch-live', 'perch-parked']);
  });

  // A kill that never lands leaves the session listed; the workspace must not vanish for good.
  it('takes a closing workspace back once tmux has gone on listing it too long', async () => {
    const s = await pollingServer();
    s.server.forgetWorkspace('perch-x', true);
    await s.ticks();
    s.clock.t += 11_000;
    await s.ticks();
    s.setTitle('✳ still here');
    await s.ticks();
    expect(s.names).toContain('still here');
  });

  // The mark lives in the status store, so a restarted agent still knows the child is waiting.
  it('lists a child as waiting from a mark the status store already held', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-waiting-'));
    dirs.push(home);
    const tmux: TmuxPort = {
      listSessions: async () => [
        { name: 'perch-child', startPath: tmpdir(), command: 'claude', createdAt: 1000, parent: 'perch-p', title: '' },
      ],
      createSession: async () => undefined,
      killSession: async () => undefined,
      hasSession: async () => true,
    };
    const status = new InMemoryStatusStore();
    status.set('perch-child', 'working');
    status.setMessagedLast('perch-child', true);
    server = new WsServer({ ...makeServerDeps(testConfig(home), noClientLog), tmux, status });
    await server.start();
    const socket = new WebSocket(await clientUrl());
    sockets.push(socket);
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket);
    socket.send(JSON.stringify({ type: 'list' }));
    const list = await nextMessage(socket);
    expect(list).toMatchObject({ type: 'workspaces', workspaces: [{ id: 'perch-child', waitingOn: 'parent' }] });
  });
});

describe('WsServer poll ticks', () => {
  function fakeTmux(listSessions: TmuxPort['listSessions']): TmuxPort {
    return {
      listSessions,
      createSession: async () => undefined,
      killSession: async () => undefined,
      hasSession: async () => true,
    };
  }

  // A tick that outlasts the interval (a loaded machine, a slow tmux) must not let the next one
  // start beside it: a stale tick finishing last would take back a workspace a newer one saw go.
  it('does not start a tick while the previous one is still running', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-overlap-'));
    dirs.push(home);
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    let calls = 0;
    const tmux = fakeTmux(async () => {
      calls++;
      await blocked;
      return [];
    });
    let ticks = 0;
    server = new WsServer({
      ...makeServerDeps(testConfig(home), noClientLog),
      tmux,
      titlePollMs: 10,
      onPollTick: () => void ticks++,
    });
    await server.start();
    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket);

    await vi.waitFor(() => expect(calls).toBeGreaterThan(0), LOADED_WAIT);
    const started = calls;
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(started);
    expect(ticks).toBe(0);

    release();
    await vi.waitFor(() => expect(ticks).toBeGreaterThan(0), LOADED_WAIT);
    socket.close();
  });

  // The guard must not turn one call that never returns (a wedged tmux) into no polling at all.
  it('starts ticks again once a hung one passes its deadline', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-hung-'));
    dirs.push(home);
    let calls = 0;
    const tmux = fakeTmux(async () => {
      calls++;
      return calls <= 2 ? new Promise<never>(() => undefined) : [];
    });
    let ticks = 0;
    server = new WsServer({
      ...makeServerDeps(testConfig(home), noClientLog),
      tmux,
      titlePollMs: 10,
      tickDeadlineMs: 100,
      onPollTick: () => void ticks++,
    });
    await server.start();
    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket);

    await vi.waitFor(() => expect(calls).toBeGreaterThan(2), LOADED_WAIT);
    socket.close();
  });

  // A status change is pushed from a fire-and-forget listing; a tmux failing there (its server
  // exiting with its last session) must not become an unhandled rejection, which ends the agent.
  it('survives a tmux failure while pushing a status change', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-pushfail-'));
    dirs.push(home);
    let failed = false;
    const tmux = fakeTmux(async () => {
      failed = true;
      throw Object.assign(new Error('tmux list-sessions failed'), { stderr: 'server exited unexpectedly\n' });
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      server = new WsServer({ ...makeServerDeps(testConfig(home), noClientLog), tmux, titlePollMs: 60_000 });
      await server.start();
      const res = await fetch(`http://127.0.0.1:${server.address().port}/hooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${HOOK_TOKEN}` },
        body: JSON.stringify({ sessionName: 'perch-x', event: 'UserPromptSubmit' }),
      });
      expect(res.status).toBe(204);
      await vi.waitFor(() => expect(failed).toBe(true), LOADED_WAIT);
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('WsServer browser-session polling', () => {
  it('pushes browserSessions when the live set changes, and only then', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-bpoll-'));
    dirs.push(home);
    const config = testConfig(home);
    // Mutable discovery: starts empty, then a session appears mid-test (as when the CLI
    // or another client starts one) — the poll must push the change without a `list`.
    let live: Array<{ name: string; streamPort: number }> = [];
    server = new WsServer({
      config,
      hookToken: HOOK_TOKEN,
      tmux: new TmuxAdapter(),
      recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(),
      reader: new FsFileReader(),
      resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory,
      clock: systemClock,
      ids: new RandomIdGenerator(),
      pty: new NodePtyAdapter(),
      status: new InMemoryStatusStore(),
      writer: new FsFileWriter(),
      browserDiscovery: { listSessions: async () => live },
      browserCommands: noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog: noWorkspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
      titlePollMs: 50,
    });
    await server.start();
    const port = server.address().port;

    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket); // authResult

    const pushed: AgentMessage[] = [];
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as AgentMessage;
      if (msg.type === 'browserSessions') pushed.push(msg);
    });

    // A few empty polls: an unchanged (empty) set must not be broadcast.
    await new Promise((r) => setTimeout(r, 300));
    expect(pushed).toEqual([]);

    live = [{ name: 'github', streamPort: 9300 }];
    await Promise.race([
      new Promise<void>((resolve) => {
        socket.on('message', (raw) => {
          if ((JSON.parse(raw.toString()) as AgentMessage).type === 'browserSessions') resolve();
        });
      }),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('no browserSessions push')), 5000)),
    ]);
    expect(pushed).toEqual([{ type: 'browserSessions', sessions: [{ name: 'github' }] }]);

    // Unchanged set → no further pushes across later polls.
    await new Promise((r) => setTimeout(r, 300));
    expect(pushed).toHaveLength(1);

    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });
});

describe('WsServer browser-session cascade', () => {
  async function startServer(browser?: {
    discovery?: BrowserDiscoveryPort;
    commands?: BrowserCommandPort;
  }): Promise<number> {
    const home = await mkdtemp(join(tmpdir(), 'perch-browser-'));
    dirs.push(home);
    const config = testConfig(home);
    server = new WsServer({
      config,
      hookToken: HOOK_TOKEN,
      tmux: new TmuxAdapter(),
      recent: new FileRecentStore(config.recentStorePath),
      lister: new FsProjectLister(),
      reader: new FsFileReader(),
      resolvePath: systemPathResolver,
      isDirectory: fsIsDirectory,
      clock: systemClock,
      ids: new RandomIdGenerator(),
      pty: new NodePtyAdapter(),
      status: new InMemoryStatusStore(),
      writer: new FsFileWriter(),
      browserDiscovery: browser?.discovery ?? noBrowserDiscovery,
      browserCommands: browser?.commands ?? noBrowserCommands,
      hiddenFolders: noHiddenFolders,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog: noWorkspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
      titlePollMs: 50,
    });
    await server.start();
    return server.address().port;
  }

  it('cascades a browser-session close when a workspace vanishes on its own (inner process exit)', async () => {
    const name = `perch-${Date.now()}-vanish`;
    const stopped: string[] = [];
    const discovery: BrowserDiscoveryPort = {
      listSessions: async () => [
        { name, streamPort: 1 },
        { name: `${name}__tab`, streamPort: 2 },
        { name: 'github', streamPort: 3 },
      ],
    };
    const commands: BrowserCommandPort = { ...noBrowserCommands, stop: async (n) => void stopped.push(n) };
    const port = await startServer({ discovery, commands });

    sessions.push(name);
    await exec('tmux', ['new-session', '-d', '-s', name, '-c', tmpdir(), 'sleep 30']);

    const socket = new WebSocket(await clientUrl());
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket); // authResult

    // Let the poller record the session as present before it disappears.
    await new Promise((r) => setTimeout(r, 200));
    // The inner process exits → tmux destroys the session, no Perch `close` message is sent.
    await exec('tmux', ['kill-session', '-t', name]);

    // The disappearance poll must cascade-stop the workspace's sessions (but not a
    // home-level per-site session like `github`).
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`cascade not observed; stopped=${stopped}`)), 3000);
      const tick = setInterval(() => {
        if (stopped.length >= 2) {
          clearInterval(tick);
          clearTimeout(deadline);
          resolve();
        }
      }, 25);
    });
    expect(stopped.sort()).toEqual([`${name}`, `${name}__tab`].sort());

    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });

  it('closes a workspace’s own browser sessions on workspace close (best-effort cascade)', async () => {
    const stopped: string[] = [];
    const discovery: BrowserDiscoveryPort = {
      listSessions: async () => [
        { name: 'perch-cascade', streamPort: 1 },
        { name: 'perch-cascade__login', streamPort: 2 },
        { name: 'perch-other', streamPort: 3 },
        { name: 'github', streamPort: 4 },
      ],
    };
    const commands: BrowserCommandPort = { ...noBrowserCommands, stop: async (n) => void stopped.push(n) };
    const port = await startServer({ discovery, commands });

    const terminal = new WebSocket(await clientUrl());
    await new Promise((r) => terminal.once('open', r));
    terminal.send(JSON.stringify({ type: 'auth', token: 'secret' }));

    const closed = new Promise<void>((resolve) => {
      terminal.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as AgentMessage;
        if (msg.type === 'closed' && msg.workspaceId === 'perch-cascade') resolve();
      });
    });
    terminal.send(JSON.stringify({ type: 'close', workspaceId: 'perch-cascade' }));
    await closed;

    // Only this workspace's sessions are stopped — never a peer's or a home-level per-site
    // session like `github`.
    expect(stopped).toEqual(['perch-cascade', 'perch-cascade__login']);
    await new Promise<void>((resolve) => {
      terminal.on('close', () => resolve());
      terminal.close();
    });
  });

});

describe('connectBrowserUpstream (real ws client adapter)', () => {
  it('connects with no Origin header, exchanges messages, exposes bufferedAmount, propagates close', async () => {
    const upstream = new WebSocketServer({ port: 0 });
    await new Promise((r) => upstream.once('listening', r));
    const port = (upstream.address() as AddressInfo).port;
    let origin: string | undefined = 'unset';
    const serverGot: string[] = [];
    upstream.on('connection', (socket, req) => {
      origin = req.headers.origin;
      socket.on('message', (raw) => {
        serverGot.push(raw.toString());
        socket.send('reply-from-upstream');
      });
    });
    try {
      const client = await connectBrowserUpstream(port);
      const received: string[] = [];
      const gotReply = new Promise<void>((resolve) => {
        client.onMessage((data) => {
          received.push(data);
          resolve();
        });
      });
      client.send('hello');
      await gotReply;
      expect(origin).toBeUndefined();
      expect(serverGot).toEqual(['hello']);
      expect(received).toEqual(['reply-from-upstream']);
      expect(typeof client.bufferedAmount?.()).toBe('number');
      const closed = new Promise<void>((resolve) => client.onClose(resolve));
      for (const socket of upstream.clients) socket.close();
      await closed;
    } finally {
      await new Promise((r) => upstream.close(r));
    }
  });

  it('rejects when nothing listens on the port', async () => {
    // Grab a free port, then close the listener so the dial hits a dead port.
    const probe = new WebSocketServer({ port: 0 });
    await new Promise((r) => probe.once('listening', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    await expect(connectBrowserUpstream(port)).rejects.toThrow();
  });
});

describe('WsServer stats push', () => {
  const reading = {
    cpuPercent: 12,
    memory: { usedBytes: 100, totalBytes: 400 },
    swapUsedBytes: 0,
    limit: { usedBytes: 90, totalBytes: 100, stallPercent: 0 },
  };

  async function startStatsServer(systemStats: SystemStatsPort): Promise<number> {
    const home = await mkdtemp(join(tmpdir(), 'perch-stats-'));
    dirs.push(home);
    const config = testConfig(home, { keytermsPath: join(home, 'keyterms.json') });
    server = new WsServer({ ...makeServerDeps(config, noClientLog), systemStats, statsPollMs: 30 });
    await server.start();
    return server.address().port;
  }

  async function authedSocket(port: number): Promise<WebSocket> {
    const socket = new WebSocket(await clientUrl());
    sockets.push(socket);
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket);
    return socket;
  }

  const sockets: WebSocket[] = [];
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });

  it('pushes a reading to a connected client on every tick', async () => {
    const port = await startStatsServer({ read: async () => reading });
    const socket = await authedSocket(port);
    const stats = await new Promise<AgentMessage>((resolve) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as AgentMessage;
        if (msg.type === 'stats') resolve(msg);
      });
    });
    expect(stats).toEqual({ type: 'stats', stats: reading });
  });

  // The collector needs two samples for a CPU delta, and a machine may have no readable
  // counters at all; either way the tick sends nothing rather than a partial reading.
  it('sends nothing while the collector has no reading', async () => {
    const port = await startStatsServer({ read: async () => null });
    const socket = await authedSocket(port);
    const seen: string[] = [];
    socket.on('message', (raw) => seen.push((JSON.parse(raw.toString()) as AgentMessage).type));
    await new Promise((r) => setTimeout(r, 120));
    expect(seen).not.toContain('stats');
  });

  // A throwing collector must not take the interval down with it — the poll is
  // fire-and-forget, so an unhandled rejection would be silent and permanent.
  it('survives a collector that throws', async () => {
    let calls = 0;
    const port = await startStatsServer({
      read: async () => {
        calls += 1;
        throw new Error('nope');
      },
    });
    await authedSocket(port);
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toBeGreaterThan(1);
  });

  it('does not poll while no client is connected', async () => {
    let calls = 0;
    const port = await startStatsServer({
      read: async () => {
        calls += 1;
        return reading;
      },
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toBe(0);
    await authedSocket(port);
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toBeGreaterThan(0);
    void port;
  });
});

describe('WsServer lost-workspace tracking', () => {
  const session = (name: string): TmuxSessionInfo => ({
    name,
    startPath: tmpdir(),
    command: 'claude',
    createdAt: 1000,
    title: '✳ Portal work',
  });

  async function until(check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('condition not reached');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('parks the workspaces lost with the tmux server, with no client connected', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-live-'));
    dirs.push(home);
    const config = testConfig(home);
    let serverId = 'srv-1';
    let sessions = [session('perch-a')];
    const tmux: TmuxPort = {
      listSessions: async () => sessions,
      serverId: async () => serverId,
      createSession: async () => undefined,
      killSession: async () => undefined,
      hasSession: async () => false,
    };
    const status = new InMemoryStatusStore();
    status.setClaudeSessionId('perch-a', 'sess-a');
    const liveSnapshot = new FileLiveSnapshotStore(config.liveSnapshotPath);
    server = new WsServer({ ...makeServerDeps(config, noClientLog), tmux, status, liveSnapshot, titlePollMs: 30 });
    await server.start();

    await until(async () => (await liveSnapshot.read())?.workspaces.length === 1);
    serverId = 'srv-2';
    sessions = [];
    const parked = new FileParkedStore(config.parkedStorePath);
    await until(async () => (await parked.get('perch-a')) !== undefined);

    expect(await parked.get('perch-a')).toMatchObject({ name: 'Portal work', claudeSessionId: 'sess-a' });
    expect(status.get('perch-a')).toBe('parked');
  });

  // An Esc interrupt fires no hook; a tmux patched for OSC 7501 still sees the turn end.
  it('ends a stale working status from the pane program status, with no client connected', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-osc-'));
    dirs.push(home);
    const config = testConfig(home);
    let program = { state: 'working', changedAt: 1000 };
    const tmux: TmuxPort = {
      listSessions: async () => [{ ...session('perch-a'), program }],
      createSession: async () => undefined,
      killSession: async () => undefined,
      hasSession: async () => true,
    };
    const status = new InMemoryStatusStore();
    status.set('perch-a', 'working');
    server = new WsServer({ ...makeServerDeps(config, noClientLog), tmux, status, titlePollMs: 30 });
    await server.start();

    await new Promise((r) => setTimeout(r, 100));
    expect(status.get('perch-a')).toBe('working');
    program = { state: 'idle', changedAt: 2000 };
    await until(async () => status.get('perch-a') === 'needs-feedback');
  });

  it('drops a workspace from the snapshot as soon as it is closed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-live-'));
    dirs.push(home);
    const config = testConfig(home);
    const liveSnapshot = new FileLiveSnapshotStore(config.liveSnapshotPath);
    await liveSnapshot.write({
      serverId: 'srv-1',
      workspaces: [{ id: 'perch-a', name: 'a', projectPath: '/', command: 'claude', machineId: 'test', createdAt: 1 }],
    });
    server = new WsServer({ ...makeServerDeps(config, noClientLog), liveSnapshot });
    server.forgetWorkspace('perch-a');
    await until(async () => (await liveSnapshot.read())?.workspaces.length === 0);
  });
});

// `perch send` asks the agent, which proves the caller runs inside the pane it names and holds
// the marks the send sets.
describe('WsServer POST /message', () => {
  const sockets: WebSocket[] = [];
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });

  async function messagingServer(descends: boolean, opts: { extra?: TmuxSessionInfo[]; listDelays?: number[] } = {}) {
    const home = await mkdtemp(join(tmpdir(), 'perch-message-'));
    dirs.push(home);
    const delays = [...(opts.listDelays ?? [])];
    const tmux: TmuxPort = {
      listSessions: async () => {
        const delay = delays.shift();
        if (delay) await new Promise((r) => setTimeout(r, delay));
        return [
          { name: 'perch-child-1', startPath: tmpdir(), command: 'claude', createdAt: 1000, parent: 'perch-orch-1', title: '' },
          { name: 'perch-orch-1', startPath: tmpdir(), command: 'claude', createdAt: 1000, title: '' },
          { name: 'perch-cx-1', startPath: tmpdir(), command: 'codex resume t1', createdAt: 1000, codexThread: 't1', title: '' },
          ...(opts.extra ?? []),
        ];
      },
      createSession: async () => undefined,
      killSession: async () => undefined,
      hasSession: async () => true,
      sessionOfPane: async (pane) => (pane === '%3' ? 'perch-child-1' : null),
      panePid: async () => 4000,
      pidOfPane: async (pane) => (pane === '%3' ? 4000 : null),
    };
    const status = new InMemoryStatusStore();
    status.set('perch-child-1', 'working');
    const delivered: Array<{ id: string; text: string }> = [];
    const logged: MessageLogEntry[] = [];
    server = new WsServer({
      ...makeServerDeps(testConfig(home), noClientLog),
      tmux,
      status,
      messaging: {
        ancestry: { isAncestor: async (ancestor, pid) => descends && ancestor === 4000 && pid === 4242 },
        delivery: {
          deliver: async (target, text) => {
            delivered.push({ id: target.id, text });
            return { ok: true };
          },
        },
        log: { append: async (e) => void logged.push(e) },
      },
    });
    await server.start();
    const port = server.address().port;
    const post = (route: string, body: unknown, token = HOOK_TOKEN) =>
      fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    return { status, delivered, logged, post };
  }

  const send = { pane: '%3', pid: 4242, to: 'perch-orch-1', body: 'done: see PR' };

  it('delivers over POST /message and marks the sender waiting', async () => {
    const { status, delivered, logged, post } = await messagingServer(true);
    const socket = new WebSocket(await clientUrl());
    sockets.push(socket);
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'auth', token: 'secret' }));
    await nextMessage(socket);
    // Not simply the next frame: a poll tick may broadcast another workspace first.
    const pushed = new Promise<AgentMessage>((resolve) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as AgentMessage;
        if (msg.type === 'workspaceUpdated' && msg.workspace.id === 'perch-child-1') resolve(msg);
      });
    });

    const res = await post('/message', send);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'delivered' });
    expect(delivered.map((d) => d.id)).toEqual(['perch-orch-1']);
    expect(delivered[0]!.text).toContain('done: see PR');
    expect(logged).toMatchObject([{ from: 'perch-child-1', to: 'perch-orch-1', relation: 'child', outcome: 'delivered' }]);
    expect(await pushed).toMatchObject({ type: 'workspaceUpdated', workspace: { id: 'perch-child-1', waitingOn: 'parent' } });

    // The Bash call that ran perch send ends, then the turn does: the child is still waiting.
    expect((await post('/hooks', { sessionName: 'perch-child-1', event: 'PostToolUse', claude: { tool_name: 'Bash' } })).status).toBe(204);
    expect((await post('/hooks', { sessionName: 'perch-child-1', event: 'Stop', claude: {} })).status).toBe(204);
    expect(status.get('perch-child-1')).toBe('working');
    socket.send(JSON.stringify({ type: 'list' }));
    let list = await nextMessage(socket);
    while (list.type !== 'workspaces') list = await nextMessage(socket);
    expect(list.workspaces.find((w) => w.id === 'perch-child-1')).toMatchObject({ waitingOn: 'parent' });
  });

  // Ids are reused: a send's pending mark must not reach the next workspace that takes the id.
  it('drops the send-during-tool mark with the rest of a gone workspace', async () => {
    const { post } = await messagingServer(true);
    expect(await (await post('/message', send)).json()).toEqual({ result: 'delivered' });
    const marks = (server as unknown as { sentDuringTool: Set<string> }).sentDuringTool;
    expect(marks.has('perch-child-1')).toBe(true);
    server!.dropWorkspaceState('perch-child-1');
    expect(marks.has('perch-child-1')).toBe(false);
  });

  it('refuses a pane the pid does not descend from', async () => {
    const { status, delivered, post } = await messagingServer(false);
    const res = await post('/message', send);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'refused', reason: 'not run from a Perch workspace' });
    expect(delivered).toEqual([]);
    expect(status.getMessagedLast('perch-child-1')).toBe(false);
  });

  it('names a Codex sender by the thread id it posts', async () => {
    const { delivered, logged, post } = await messagingServer(false);
    const res = await post('/message', { ...send, pane: '', codexThread: 't1' });
    expect(await res.json()).toEqual({ result: 'delivered' });
    expect(delivered.map((d) => d.id)).toEqual(['perch-orch-1']);
    expect(logged).toMatchObject([{ from: 'perch-cx-1', outcome: 'delivered' }]);
    expect((await post('/message', { ...send, codexThread: 42 })).status).toBe(400);
  });

  it('a Codex hook by thread lands on its workspace', async () => {
    const { status, post } = await messagingServer(true);
    expect((await post('/hooks', { thread: 't1', event: 'UserPromptSubmit', agent: 'codex', claude: { session_id: 't1' } })).status).toBe(204);
    expect(status.get('perch-cx-1')).toBe('working');
  });

  it('an unknown thread changes nothing', async () => {
    const { status, post } = await messagingServer(true);
    expect((await post('/hooks', { thread: 'zz', event: 'Stop', agent: 'codex', claude: {} })).status).toBe(204);
    expect(status.get('perch-cx-1')).toBeUndefined();
    expect(status.get('perch-child-1')).toBe('working');
    expect((await post('/hooks', { event: 'Stop', agent: 'codex', claude: {} })).status).toBe(400);
  });

  it('drops a thread post that is not from Codex, or names a thread only a non-Codex session records', async () => {
    const extra = [{ name: 'perch-cl-1', startPath: tmpdir(), command: 'claude', createdAt: 1000, codexThread: 't2', title: '' }];
    const { status, post } = await messagingServer(true, { extra });
    expect((await post('/hooks', { thread: 't1', event: 'UserPromptSubmit', claude: {} })).status).toBe(204);
    expect((await post('/hooks', { thread: 't1', event: 'UserPromptSubmit', agent: 'claude', claude: {} })).status).toBe(204);
    expect(status.get('perch-cx-1')).toBeUndefined();
    expect((await post('/hooks', { thread: 't2', event: 'UserPromptSubmit', agent: 'codex', claude: {} })).status).toBe(204);
    expect(status.get('perch-cl-1')).toBeUndefined();
  });

  it('drops a hook for a thread more than one session records', async () => {
    const extra = [{ name: 'perch-cx-2', startPath: tmpdir(), command: 'codex resume t1', createdAt: 1000, codexThread: 't1', title: '' }];
    const { status, post } = await messagingServer(true, { extra });
    expect((await post('/hooks', { thread: 't1', event: 'UserPromptSubmit', agent: 'codex', claude: {} })).status).toBe(204);
    expect(status.get('perch-cx-1')).toBeUndefined();
    expect(status.get('perch-cx-2')).toBeUndefined();
  });

  // The first post's session lookup is the slow one: applied on lookup, it would land last.
  it('applies thread hooks in the order they arrive', async () => {
    const { status, post } = await messagingServer(true, { listDelays: [80, 0] });
    const first = post('/hooks', { thread: 't1', event: 'UserPromptSubmit', agent: 'codex', claude: {} });
    await new Promise((r) => setTimeout(r, 20));
    const second = post('/hooks', { thread: 't1', event: 'Stop', agent: 'codex', claude: {} });
    expect((await first).status).toBe(204);
    expect((await second).status).toBe(204);
    expect(status.get('perch-cx-1')).toBe('needs-feedback');
  });

  it('401 without the secret, 400 for a malformed body', async () => {
    const { delivered, post } = await messagingServer(true);
    expect((await post('/message', send, 'wrong')).status).toBe(401);
    expect((await post('/message', { ...send, pid: '4242' })).status).toBe(400);
    expect((await post('/message', { ...send, pid: 42.5 })).status).toBe(400);
    expect((await post('/message', { ...send, body: undefined })).status).toBe(400);
    expect((await post('/message', 'not json at all')).status).toBe(400);
    expect(delivered).toEqual([]);
  });
});
