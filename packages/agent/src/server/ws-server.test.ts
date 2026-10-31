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
import type { CommandsPort } from '../ports/commands-port';
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
import type { AgentMessage } from '@perch/contracts';
import {
  SecureSession,
  IkInitiator,
  b64url,
  encodeDeviceHello,
  ed25519Signer,
  signDeviceHello,
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

// Plays the phone on the relay path: a Noise session against the agent's public key, IK with a
// device key, NK without.
// A phone with a device key (a fresh, unknown one unless given).
async function noiseClient(url: string, agentPublicKey: string, device: DeviceKeys = generateDeviceKeys()) {
  const socket = new WebSocket(url);
  await new Promise((r) => socket.once('open', r));
  const reply = new Promise<Buffer>((r) => socket.once('message', (data: Buffer) => r(data)));
  const initiator = new IkInitiator(rawStaticKey(b64url.decode(device.x25519.privateKey)), b64url.decode(agentPublicKey));
  const hello = async (hash: Uint8Array) =>
    encodeDeviceHello({
      sig: device.ed25519.publicKey,
      name: 'test phone',
      proof: await signDeviceHello(ed25519Signer(device.ed25519.privateKey), b64url.decode(device.x25519.publicKey), hash),
    });
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
const noCommands: CommandsPort = { list: async () => [] };
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

// Phones reach the agent only through relays. These tests hand the server a plaintext client over
// a local socket of their own, to exercise what it does with a client.
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

function testConfig(home: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    machineId: 'test',
    token: 'secret',
    port: 0,
    projectRoots: [tmpdir()],
    recentStorePath: join(home, 'recent.json'),
    statusStorePath: join(home, 'status.json'),
    hiddenFoldersPath: join(home, 'hidden-folders.json'),
    commandsPath: join(home, 'commands.json'),
    launchersPath: join(home, 'launchers.json'),
    keytermsPath: join(home, 'keyterms.txt'),
    clientLogPath: join(home, 'client-log.jsonl'),
    hookEventLogPath: join(home, 'hook-events.jsonl'),
    workspaceLogPath: join(home, 'workspace-log.jsonl'),
    parkedStorePath: join(home, 'parked.json'),
    liveSnapshotPath: join(home, 'live.json'),
    relayUrls: [],
    relayKeyPath: join(home, 'relay-key.json'),
    devicesPath: join(home, 'devices.json'),
    pairingPath: join(home, 'pairing.json'),
    claudeSessionsDir: join(home, 'claude-sessions'),
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
    commands: noCommands,
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
      commands: noCommands,
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

  it('serves a relay-dialed socket only through the Noise session, token check unchanged', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-relayed-'));
    dirs.push(home);
    const config = testConfig(home);
    const keys = generateAgentKeys();
    server = new WsServer(makeServerDeps(config, noClientLog));
    // Stands in for the relay: a socket the agent did not accept on its own listener.
    const outside = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => outside.once('listening', r));
    const devices = {
      check: async () => ({ standing: 'unknown' as const, enrolment: 'on' as const }),
      enrol: async () => true,
      redeemPairing: async () => ({ redeemed: false as const }),
      burnPairing: async () => false,
    };
    outside.on('connection', (socket) =>
      server?.acceptRelaySocket(wsFrameSocket(socket), b64url.decode(keys.x25519.privateKey), { devices }),
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
      // The agent hangs up on a failed auth, freeing the relay's pair slot.
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
    const devices = new RosterDevices({ store, pairings, now: () => new Date(), account: 'acct', enrolKey: new Uint8Array(32), onChange: () => undefined });
    server = new WsServer(makeServerDeps(config, noClientLog));
    const outside = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => outside.once('listening', r));
    outside.on('connection', (socket) =>
      server?.acceptRelaySocket(wsFrameSocket(socket), b64url.decode(keys.x25519.privateKey), { devices }),
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
      await vi.waitFor(async () => expect((await store.read()).devices.map((d) => d.x25519)).toContain(paired.x25519.publicKey));
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
      commands: noCommands,
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
      commands: noCommands,
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
      commands: noCommands,
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
      commands: noCommands,
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
      commands: noCommands,
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
    await new Promise((r) => setTimeout(r, 300));
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

  it('polls tmux and pushes a closed when a session disappears', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-gone-'));
    dirs.push(home);
    const config = testConfig(home);
    const workspaceLogged: WorkspaceLogEntry[] = [];
    const workspaceLog: WorkspaceLogPort = { append: async (e) => void workspaceLogged.push(e) };
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
      commands: noCommands,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
      titlePollMs: 50,
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
    await new Promise((r) => setTimeout(r, 300));
    await exec('tmux', ['kill-session', '-t', name]);

    const msg = await closed;
    expect(msg.type).toBe('closed');
    if (msg.type === 'closed') {
      expect(msg.workspaceId).toBe(name);
    }
    expect(workspaceLogged).toEqual([
      expect.objectContaining({ id: name, projectPath: tmpdir(), reason: 'exited' }),
    ]);

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
      commands: noCommands,
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
    await new Promise((r) => setTimeout(r, 450));

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

    // Give the next poll tick(s) a chance to run and confirm no duplicate 'exited' entry appears.
    await new Promise((r) => setTimeout(r, 450));
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
      commands: noCommands,
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
      commands: noCommands,
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
      commands: noCommands,
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
      commands: noCommands,
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
    });

    // Still listed as parked — the PWA sees no gap, and parking is not a close.
    socket.send(JSON.stringify({ type: 'list' }));
    const listed = await nextMessage(socket);
    expect(listed.type).toBe('workspaces');
    if (listed.type === 'workspaces') {
      expect(listed.workspaces.find((w) => w.id === name)).toMatchObject({ status: 'parked' });
    }
    expect(logged.find((e) => e.id === name)).toBeUndefined();

    // Reopening recreates the session.
    socket.send(JSON.stringify({ type: 'attach', workspaceId: name, cols: 80, rows: 24 }));
    await vi.waitFor(async () => {
      expect(await tmux.hasSession(name)).toBe(true);
    });
    // unparkWorkspace creates the session before clearing the record, so hasSession can
    // flip true a moment before the parked-store write lands — poll this too rather than
    // reading the file exactly once.
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(config.parkedStorePath, 'utf8'))).toEqual([]);
    });

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
      commands: noCommands,
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
    });

    const parked = JSON.parse(await readFile(config.parkedStorePath, 'utf8')) as Array<{ id: string; command: string }>;
    expect(parked).toHaveLength(1);
    expect(parked[0]?.command).toBe('claude');

    socket.send(JSON.stringify({ type: 'list' }));
    const listed = await nextMessage(socket);
    expect(listed.type).toBe('workspaces');
    if (listed.type === 'workspaces') {
      expect(listed.workspaces.find((w) => w.id === name)).toMatchObject({ status: 'parked' });
    }

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
      commands: noCommands,
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
      commands: noCommands,
      launchers: noLaunchers,
      detectInstalled: async () => [],
      keyterms: noKeyterms,
      clientLog: noClientLog,
      workspaceLog,
      parked: new FileParkedStore(config.parkedStorePath),
      connectUpstream: noConnectUpstream,
      titlePollMs: 50,
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
    await new Promise((r) => setTimeout(r, 300));

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

    // Give several poll ticks (titlePollMs: 50) a chance to run against the settled state.
    // Absence can't be `vi.waitFor`'d, so wait a fixed window well past several ticks, then
    // assert.
    await new Promise((r) => setTimeout(r, 400));

    expect(closedForParked).toEqual([]);
    expect(logged.find((e) => e.id === name)).toBeUndefined();

    socket.send(JSON.stringify({ type: 'list' }));
    const listed = await nextMessage(socket);
    expect(listed.type).toBe('workspaces');
    if (listed.type === 'workspaces') {
      expect(listed.workspaces.find((w) => w.id === name)).toMatchObject({ status: 'parked' });
    }

    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.close();
    });
  });
});

describe('WsServer listener', () => {
  // Phones come through the relays the agent dials out to: the only thing listening is the
  // loopback hooks endpoint, and it answers nothing a phone used to ask for.
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
      commands: noCommands,
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
      commands: noCommands,
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
      const relay = await connectBrowserUpstream(port);
      const received: string[] = [];
      const gotReply = new Promise<void>((resolve) => {
        relay.onMessage((data) => {
          received.push(data);
          resolve();
        });
      });
      relay.send('hello');
      await gotReply;
      expect(origin).toBeUndefined();
      expect(serverGot).toEqual(['hello']);
      expect(received).toEqual(['reply-from-upstream']);
      expect(typeof relay.bufferedAmount?.()).toBe('number');
      const closed = new Promise<void>((resolve) => relay.onClose(resolve));
      for (const client of upstream.clients) client.close();
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
