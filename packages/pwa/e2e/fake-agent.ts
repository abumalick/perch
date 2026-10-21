import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { audioMediaType, imageMediaType, pdfMediaType } from '@perch/contracts';
import { REFUSAL, accountId, generateAgentKeys, generatePairingSecret } from '@perch/secure-channel';
import { MemoryRegistry } from '@perch/relay/registry';
import { startRelayServer } from '@perch/relay/server';
import { startRelayLinks } from '@perch/agent/src/server/relay-wiring.ts';
import { NoiseClientConnection, type NoiseClientConnectionOptions } from '@perch/agent/src/server/noise-client-connection.ts';
import { frameSocketTransport } from '@perch/agent/src/infrastructure/ws-frame-socket.ts';
import { createWsRelayTransport } from '@perch/agent/src/infrastructure/ws-relay-transport.ts';
import { FileDeviceStore } from '@perch/agent/src/infrastructure/file-device-store.ts';
import { FilePairingStore } from '@perch/agent/src/infrastructure/file-pairing-store.ts';
import { addPairing } from '@perch/agent/src/application/pairing.ts';
import { revokeDevice } from '@perch/agent/src/application/device-roster.ts';
import type { RelayTransport } from '@perch/agent/src/ports/relay-port.ts';
import type { FrameSocket } from '@perch/agent/src/ports/frame-socket.ts';

// The machine token a seeded entry carries (`machineEntry`), as the agent's PERCH_TOKEN.
const TOKEN = 'secret';

// A 1×1 transparent PNG, served as an in-session media read.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

// A minimal PDF byte blob served for .pdf paths. The e2e only asserts the PWA reads it and
// mounts an iframe with a blob URL — it needn't be a fully renderable PDF.
const TINY_PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8');

// A minimal audio byte blob served for audio paths. The e2e only asserts the PWA reads it and
// mounts an <audio> with a blob URL — it needn't be a playable clip.
const TINY_AUDIO = Buffer.from('ID3\x03\x00\x00\x00', 'binary');

// An 8×8 solid-color JPEG served as the browser stream's canned frame. The frame's
// metadata (not the JPEG's own size) drives the PWA's coordinate mapping, so it carries
// a realistic 1280×720 device size.
const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAB//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ALQBCZX/2Q==';
const BROWSER_FRAME_METADATA = { deviceWidth: 1280, deviceHeight: 720 };

// The canned bytes a media path is served as,
// typed as the real agent types it (from the extension).
function mediaFor(path: string): { type: string; bytes: Buffer } | null {
  if (imageMediaType(path)) return { type: imageMediaType(path), bytes: TINY_PNG };
  if (pdfMediaType(path)) return { type: pdfMediaType(path), bytes: TINY_PDF };
  if (audioMediaType(path)) return { type: audioMediaType(path), bytes: TINY_AUDIO };
  return null;
}

// One client connection inside its Noise session, as the message switch sees it.
interface Conn {
  // What the transport proved (the real `ClientConnection.keyCredential`): an enrolled device key,
  // or a pairing code spent just now. `auth` then needs no token.
  readonly keyCredential?: 'device' | 'pairing';
  send: (message: unknown) => void;
  refuse: (reason: string) => void;
  close: () => void;
  onMessage: (listener: (message: Record<string, unknown>) => void) => void;
  onClose: (listener: () => void) => void;
}

// The real agent's relay session: the IK handshake, the device gate over the roster and pairing
// files, enrolment at `authResult`, refusals in band. Only the message switch below is fake.
function noiseConn(conn: NoiseClientConnection): Conn {
  return {
    get keyCredential() {
      return conn.keyCredential;
    },
    send: (m) => conn.send(m as never),
    refuse: (reason) => conn.refuse(reason),
    close: () => conn.close(),
    onMessage: (l) => conn.onMessage((raw) => l(raw as Record<string, unknown>)),
    onClose: (l) => conn.onClose(l),
  };
}

// The production ws transport, watched: each `applied` the relay sends on the control socket.
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

export interface FakeAgent {
  // The relay in front of the agent.
  port: number;
  // The agent's account on it, and the URL a machine entry for it holds.
  account: string;
  url: string;
  // Records each `create` the agent received, so a spec can assert the command that was sent.
  created: Array<{ projectPath: string; command: string }>;
  // Every message received on the terminal socket, so specs can assert fire-and-forget
  // client messages that the agent answers with nothing.
  received: Array<Record<string, unknown>>;
  sendOutput: (workspaceId: string, data: string) => void;
  // Every message received on a browser stream, so specs can assert input/navigate.
  browserReceived: Array<{ session: string; message: Record<string, unknown> }>;
  // The live browser-session set the fake reports (mutable): `list` replies with it.
  browserSessions: Array<{ name: string }>;
  // Closes every open browser stream (`browserClosed`), simulating a transient drop.
  closeBrowserSockets: () => void;
  // The agent's X25519 public key a machine entry pins.
  agentKey: string;
  // Connection-log batches received inside the session.
  clientLogs: unknown[];
  // What a media path is served as instead of its canned bytes, keyed by file name (mutable): lets
  // a spec play a hostile agent that answers a `.pdf` with another media type.
  mediaOverrides: Map<string, { type: string; bytes: Buffer }>;
  // Phone upgrades the relay saw, refused ones included.
  upgrades: number;
  // Mints a pairing code, as `perch pair` does: live, or already expired or spent.
  newPairing: (state?: 'live' | 'expired' | 'used') => Promise<string>;
  // Revokes every enrolled device, as `perch devices revoke` does from another process: the
  // agent notices, closes their sessions and republishes, and resolves once the relay has it.
  revokeAll: () => Promise<void>;
  close: () => Promise<void>;
}

type FakeWorkspace = {
  machineId: string;
  id: string;
  name: string;
  projectPath: string;
  command: string;
  createdAt: number;
  lastActivityAt: number;
  status: string;
  agentAddress?: string;
  urgent?: boolean;
  github?: { owner: string; repo: string; ownerType?: 'user' | 'org' };
};

// The default two-workspace set most specs rely on. Pass `workspacesOverride` to exercise a
// different shape (e.g. a long-named session for the list-overflow guard) without disturbing it.
const DEFAULT_WORKSPACES: FakeWorkspace[] = [
  { machineId: 'agent-machine-id', id: 'perch-demo', name: 'demo', projectPath: '/home/u/workspace/demo', command: 'bash', createdAt: 1, lastActivityAt: 1, status: 'needs-feedback', agentAddress: 'demo-7f', github: { owner: 'Acme-Org', repo: 'acme-app', ownerType: 'org' } },
  { machineId: 'agent-machine-id', id: 'perch-other', name: 'other', projectPath: '/home/u/workspace/other', command: 'bash', createdAt: 2, lastActivityAt: 2, status: 'idle' },
];

// A machine entry for this fake, as a pairing would store it; `seedMachine` writes it before the
// page loads.
export function machineEntry(agent: FakeAgent, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'test', name: 'Test', url: agent.url, token: TOKEN, relay: true, agentKey: agent.agentKey, ...overrides };
}

export async function seedMachine(page: Page, agent: FakeAgent, overrides: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((m) => localStorage.setItem('perch.machines', JSON.stringify([m])), machineEntry(agent, overrides));
}

// The real relay path in front of a fake agent: the self-hosted relay server (`@perch/relay`) and
// the agent's own relay side (RelayLink, the published policy, the device gate over roster and
// pairing files in a scratch directory), so every spec runs the challenge, the device signature,
// the enrolment proofs and the IK handshake in WebKit. Only the messages inside the session are
// canned. A seeded entry enrols its fresh device key with the token on first connect.
export async function startFakeAgent(
  workspacesOverride?: FakeWorkspace[],
  browserSessionsOverride?: Array<{ name: string }>,
): Promise<FakeAgent> {
  const keys = generateAgentKeys();
  const account = accountId(keys.ed25519.publicKey);
  await mkdir('.tmp', { recursive: true });
  const home = await mkdtemp(join('.tmp', 'fake-agent-'));
  const store = new FileDeviceStore(join(home, 'devices.json'));
  const pairings = new FilePairingStore(join(home, 'pairing.json'));
  let upgrades = 0;
  const relay = await startRelayServer({
    port: 0,
    host: '127.0.0.1',
    registry: new MemoryRegistry({ accounts: { [account]: { key: keys.ed25519.publicKey, addedAt: new Date().toISOString() } } }),
    // Every test is a fresh browser, so a new device key asking to enrol.
    limits: { maxEnrolments: 10_000 },
    trace: (line) => {
      if (line.startsWith('relay client upgrade')) upgrades += 1;
    },
  });
  let appliedWaiters: Array<() => void> = [];
  const nextApplied = () => new Promise<void>((resolve) => appliedWaiters.push(resolve));
  const firstApplied = nextApplied();
  const relayClients = new Set<NoiseClientConnection>();
  {
    const browserReceived: Array<{ session: string; message: Record<string, unknown> }> = [];
    // Each connection's open browser streams: stream id → session name.
    const openStreams = new Map<Conn, Map<string, string>>();
    // Faithful to the real agent's single-viewer registry (keyed by session name): a new authed
    // viewer of the same session evicts the prior one with ended{opened-elsewhere}.
    const browserHolders = new Map<string, { conn: Conn; stream: string }>();
    // Faithful to the real agent's ViewerRegistry: one viewer per workspace. A new attach
    // evicts the prior holder with `detached: opened-elsewhere`, which is what drives the
    // "Opened on another device" overlay in the PWA.
    const holders = new Map<string, Conn>();
    const conns = new Set<Conn>();
    const clientLogs: unknown[] = [];
    const mediaOverrides = new Map<string, { type: string; bytes: Buffer }>();
    // Shared workspace state so a setStatus flips the status and the change is broadcast to
    // every connection — faithful to the real agent's synced, last-writer-wins status store.
    const workspaces = workspacesOverride ?? DEFAULT_WORKSPACES.map((w) => ({ ...w }));
    const created: Array<{ projectPath: string; command: string }> = [];
    const received: Array<Record<string, unknown>> = [];
    // Mirrors a machine with `claude` installed (not `codex`) that has launched `pi` before.
    let customLaunchers = ['pi'];
    // One live agent-browser session named after the demo workspace (attached by the
    // name === workspace.id rule) when that workspace exists.
    const browserSessions: Array<{ name: string }> =
      browserSessionsOverride ??
      (workspaces.some((w) => w.id === 'perch-demo') ? [{ name: 'perch-demo' }] : []);
    const serve = (conn: Conn) => {
      conns.add(conn);
      let attached = '';
      const streams = new Map<string, string>();
      // Streams whose opening `auth` has been answered.
      const authedStreams = new Set<string>();
      openStreams.set(conn, streams);
      const releaseHolder = (stream: string) => {
        const session = streams.get(stream);
        const holder = session === undefined ? undefined : browserHolders.get(session);
        if (holder && holder.conn === conn && holder.stream === stream) browserHolders.delete(session!);
      };
      conn.onClose(() => {
        conns.delete(conn);
        openStreams.delete(conn);
        for (const stream of streams.keys()) releaseHolder(stream);
        if (attached && holders.get(attached) === conn) holders.delete(attached);
      });
      conn.onMessage((msg) => {
        received.push(msg);
        const send = conn.send;
        switch (msg.type) {
          case 'auth': {
            // Faithful to the real agent's handler: auth returns ONLY authResult (with the side
            // channels it serves). Workspaces are sent in response to an explicit `list` — so the
            // E2E exercises the client actually requesting the list on connect. The session adds
            // `enrolled` once the roster is written, and the PWA then forgets the token.
            const byKey = conn.keyCredential;
            const isToken = msg.token === TOKEN;
            if (byKey === 'device' && isToken) {
              conn.refuse(REFUSAL.tokenNotNeeded);
            } else if (byKey || isToken) {
              send({ type: 'authResult', ok: true, credential: byKey ?? 'token' });
            } else {
              send({ type: 'authResult', ok: false });
              conn.close();
            }
            break;
          }
          case 'readMedia': {
            // Faithful to the real agent's chunked read; the canned files fit in one chunk.
            const id = String(msg.id);
            const media = mediaOverrides.get(String(msg.path).split('/').pop() ?? '') ?? mediaFor(String(msg.path));
            if (!media) {
              send({ type: 'media', id, result: 'not-found' });
              break;
            }
            send({ type: 'media', id, result: 'ok', mediaType: media.type, size: media.bytes.byteLength });
            send({ type: 'mediaChunk', id, seq: 0, data: media.bytes.toString('base64') });
            break;
          }
          case 'browserOpen':
            streams.set(String(msg.stream), String(msg.session));
            break;
          case 'browserClose':
            releaseHolder(String(msg.stream));
            streams.delete(String(msg.stream));
            break;
          case 'browser': {
            // The browser protocol inside the stream. Faithful to the real agent, its opening
            // `auth` is admitted whatever its token (the session is already authenticated, and
            // a paired phone holds no token); anything else first closes it. `authResult` then
            // piping — one `url` and one canned `frame` stand in for it.
            const stream = String(msg.stream);
            const session = streams.get(stream);
            if (session === undefined) break;
            const inner = JSON.parse(String(msg.data)) as Record<string, unknown>;
            browserReceived.push({ session, message: inner });
            const sendBrowser = (m: unknown) => send({ type: 'browser', stream, data: JSON.stringify(m) });
            if (inner.type !== 'auth' && !authedStreams.has(stream)) {
              streams.delete(stream);
              send({ type: 'browserClosed', stream });
              break;
            }
            if (inner.type === 'auth') {
              authedStreams.add(stream);
              const prior = browserHolders.get(session);
              if (prior && (prior.conn !== conn || prior.stream !== stream)) {
                prior.conn.send({ type: 'browser', stream: prior.stream, data: JSON.stringify({ type: 'ended', reason: 'opened-elsewhere' }) });
                prior.conn.send({ type: 'browserClosed', stream: prior.stream });
                openStreams.get(prior.conn)?.delete(prior.stream);
              }
              browserHolders.set(session, { conn, stream });
              sendBrowser({ type: 'authResult', ok: true });
              sendBrowser({ type: 'url', url: 'https://example.com/' });
              sendBrowser({ type: 'frame', data: TINY_JPEG_B64, metadata: BROWSER_FRAME_METADATA });
            } else if (inner.type === 'ping') {
              sendBrowser({ type: 'pong' });
            }
            break;
          }
          case 'clientLog':
            clientLogs.push(msg.batch);
            send({ type: 'clientLogAck', id: String(msg.id), ok: true });
            break;
          case 'list':
            // machineId here is the AGENT's PERCH_MACHINE_ID, deliberately DIFFERENT from the
            // PWA's machine config id (seeded as 'test' in the E2E). The client must route
            // attach/input by the connection id, not this value — so the E2E covers that.
            send({ type: 'workspaces', workspaces });
            // Faithful to the real agent: browserSessions follows every workspaces reply;
            // sending the (possibly empty) list also marks the agent as browser-capable.
            send({ type: 'browserSessions', sessions: browserSessions });
            // Faithful to a Linux agent: load readings arrive unprompted on a timer. One
            // right after the list is enough for the E2E, and mirrors the first real tick.
            send({
              type: 'stats',
              stats: {
                cpuPercent: 12,
                memory: { usedBytes: 17_179_869_184, totalBytes: 31_138_512_896 },
                swapUsedBytes: 9_771_384_832,
                limit: {
                  usedBytes: 16_451_035_136,
                  totalBytes: 18_253_611_008,
                  stallPercent: 0,
                  maxBytes: 21_474_836_480,
                  reclaimableBytes: 4_617_089_024,
                  oomKills: 7,
                },
              },
            });
            break;
          case 'setStatus': {
            const ws = workspaces.find((w) => w.id === String(msg.workspaceId));
            if (ws) {
              ws.status = String(msg.status);
              for (const client of conns) {
                client.send({ type: 'workspaceUpdated', workspace: ws });
              }
            }
            break;
          }
          case 'setUrgent': {
            // Faithful to the real agent: the pin is orthogonal to status and broadcast to
            // every device via workspaceUpdated.
            const ws = workspaces.find((w) => w.id === String(msg.workspaceId));
            if (ws) {
              ws.urgent = Boolean(msg.urgent);
              for (const client of conns) {
                client.send({ type: 'workspaceUpdated', workspace: ws });
              }
            }
            break;
          }
          case 'attach': {
            attached = String(msg.workspaceId);
            const prior = holders.get(attached);
            if (prior && prior !== conn) {
              prior.send({ type: 'detached', workspaceId: attached, reason: 'opened-elsewhere' });
            }
            holders.set(attached, conn);
            send({ type: 'attached', workspaceId: attached });
            // Note: the UTF-8 output-decoding regression is guarded by the store unit test
            // (`hi─é` roundtrip); headless xterm doesn't reliably expose non-ASCII glyph
            // text to Playwright, so this E2E keeps the rendering assertion ASCII.
            // The id is echoed in the banner so a switch between workspaces is observable
            // in the rendered terminal (each session shows distinct content).
            // Include an OSC 8 hyperlink (a label carrying a hidden URL, like Claude Code's
            // file/doc links) so the E2E can assert it is clickable. Plain-text URLs are
            // covered by the WebLinksAddon; OSC 8 links need the terminal's linkHandler.
            const osc8 = '\x1b]8;;https://example.com/osc8\x1b\\OSC8LINK\x1b]8;;\x1b\\\r\n';
            send({ type: 'output', workspaceId: attached, data: Buffer.from(`PERCH_READY ${attached}\r\n${osc8}`, 'utf8').toString('base64') });
            break;
          }
          case 'input':
            send({ type: 'output', workspaceId: attached, data: Buffer.from('echoed\r\n').toString('base64') });
            break;
          case 'putFile':
            // Faithful to the real agent: resolve by the message's workspaceId (NOT attach
            // state — a putFile can arrive before attach, e.g. a shared image flushed on open),
            // persist under <cwd>/.tmp/files, and reply with the relative path. (No real disk
            // write needed in the fake.)
            send({ type: 'fileStored', workspaceId: String(msg.workspaceId), path: `.tmp/files/${String(msg.name)}` });
            break;
          case 'create': {
            const projectPath = String(msg.projectPath);
            const command = String(msg.command);
            created.push({ projectPath, command });
            const ws: FakeWorkspace = {
              machineId: 'agent-machine-id',
              id: `perch-created-${created.length}`,
              name: projectPath.split('/').pop() || 'created',
              projectPath,
              command,
              createdAt: 100 + created.length,
              lastActivityAt: 100 + created.length,
              status: 'idle',
            };
            workspaces.push(ws);
            for (const client of conns) {
              client.send({ type: 'workspaceUpdated', workspace: ws });
            }
            break;
          }
          case 'close':
            send({ type: 'closed', workspaceId: String(msg.workspaceId) });
            break;
          case 'browseDir': {
            const path = String(msg.path);
            send({ type: 'dirEntries', path, subdirs: [`${path}/src`], files: [`${path}/README.md`, `${path}/logo.png`, `${path}/photo.png`, `${path}/report.pdf`, `${path}/clip.mp3`, `${path}/song-a.mp3`, `${path}/song-b.mp3`] });
            break;
          }
          case 'makeDir': {
            // Faithful to the real agent: create the folder, then reply with a dirEntries for
            // the new (empty) folder so the picker browses into it.
            const created = `${String(msg.parent)}/${String(msg.name)}`;
            send({ type: 'dirEntries', path: created, subdirs: [], files: [] });
            break;
          }
          case 'listLaunchers':
            send({ type: 'launchers', detected: ['claude'], custom: customLaunchers });
            break;
          case 'forgetLauncher':
            customLaunchers = customLaunchers.filter((c) => c !== msg.command);
            send({ type: 'launchers', detected: ['claude'], custom: customLaunchers });
            break;
          case 'listRoots':
            send({ type: 'roots', roots: ['/home/u/workspace'] });
            break;
          // Mirrors a machine with a ~/.perch/commands.json: one command that takes an
          // argument and one that submits on the spot.
          case 'listCommands':
            send({
              type: 'commands',
              commands: [
                { command: '/myplugin:task', submit: false },
                { command: '/rename', submit: true },
              ],
            });
            break;
          // Mirrors a machine with a ~/.perch/keyterms.txt dictation vocabulary.
          case 'listKeyterms':
            send({ type: 'keyterms', keyterms: ['Perch', 'HeliBoard'] });
            break;
          case 'readFile': {
            // Text only — media files are read with readMedia.
            const path = String(msg.path);
            // Markdown gets a heading so the viewer's rendered mode is exercised.
            const body = path.endsWith('.md')
              ? `# contents of ${path}\n\nsecond line\n`
              : `contents of ${path}\nsecond line\n`;
            send({
              type: 'fileContents',
              path,
              data: Buffer.from(body, 'utf8').toString('base64'),
              truncated: false,
              binary: false,
            });
            break;
          }
          case 'ping':
            // Faithful to the real agent: answer the liveness probe so the client's heartbeat
            // keeps the connection alive.
            send({ type: 'pong' });
            break;
          default:
            break;
        }
      });
    };
    const relays = startRelayLinks({
      config: { relayUrls: [`ws://127.0.0.1:${relay.port}`], token: TOKEN },
      keys,
      server: {
        acceptRelaySocket(socket: FrameSocket, staticPrivate: Uint8Array, options: NoiseClientConnectionOptions) {
          const conn = new NoiseClientConnection(socket, staticPrivate, options);
          relayClients.add(conn);
          conn.onClose(() => relayClients.delete(conn));
          serve(noiseConn(conn));
        },
        refuseRevokedDevices(isRevoked: (x25519: string) => boolean) {
          for (const conn of relayClients) if (conn.device && isRevoked(conn.device)) conn.refuse('device revoked');
        },
      },
      store,
      pairings,
      transport: watchedTransport(() => {
        const waiters = appliedWaiters;
        appliedWaiters = [];
        waiters.forEach((w) => w());
      }),
      log: () => undefined,
      rosterPollMs: 60_000,
      // Every test is a fresh browser, so a new device key asking to enrol (as the relay's limit above).
      enrolmentChecksPerMinute: 10_000,
    });
    // Up once the relay holds the agent's policy: from then on it gates phones by device key.
    await firstApplied;
    return {
      port: relay.port,
      account,
      url: `ws://127.0.0.1:${relay.port}/${account}`,
      get upgrades() {
        return upgrades;
      },
      set upgrades(n: number) {
        upgrades = n;
      },
      created,
      received,
      sendOutput: (workspaceId, data) => {
        holders.get(workspaceId)?.send({
          type: 'output', workspaceId, data: Buffer.from(data).toString('base64'),
        });
      },
      browserReceived,
      browserSessions,
      agentKey: keys.x25519.publicKey,
      clientLogs,
      mediaOverrides,
      newPairing: async (state = 'live') => {
        const secret = generatePairingSecret();
        const past = new Date(Date.now() - 60_000).toISOString();
        await pairings.update((list) => {
          if (state === 'live') return addPairing(list, secret, new Date());
          return [...list, state === 'used' ? { secret, expiresAt: past, usedAt: past, usedBy: 'another-device' } : { secret, expiresAt: past }];
        });
        return secret;
      },
      revokeAll: async () => {
        await store.update((roster) => roster.devices.reduce((r, d) => revokeDevice(r, d.id, new Date()).roster, roster));
        const applied = nextApplied();
        await relays.pollRoster();
        await applied;
      },
      closeBrowserSockets: () => {
        for (const [conn, streams] of openStreams) {
          for (const stream of streams.keys()) conn.send({ type: 'browserClosed', stream });
          streams.clear();
        }
        browserHolders.clear();
      },
      close: async () => {
        relays.stop();
        await relay.close();
        await rm(home, { recursive: true, force: true });
      },
    };
  }
}
