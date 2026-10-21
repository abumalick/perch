// Plays the phone against a live agent through a relay, end to end encrypted, to verify a
// deployment and measure round trips. Not part of the product.
//
//   PERCH_URL        wss://<relay host>/<account>
//   AGENT_KEY        the agent's relay key (X25519, base64url), as `perch pair` prints it
//   DEVICE_KEY_FILE  optional: this client's device key file, default ~/.perch/verify-device.json
//                    (created on first use). It signs the relay's challenge and runs IK like the
//                    phone. Enrol it once with `enrol`; an enrolled key needs no token.
//   PERCH_TOKEN      optional: the machine token, for a device key that is not enrolled yet, on an
//                    agent whose token enrolment is on. Leave it unset for an enrolled key: the agent
//                    refuses a token from one.
//
//   tsx scripts/verify.ts enrol '<pairing link>'                  enrols the device key file with a `perch pair` link
//                                                                  and prints the PERCH_URL and AGENT_KEY to use
//   tsx scripts/verify.ts list
//   tsx scripts/verify.ts create <projectPath> <command>
//   tsx scripts/verify.ts send <workspaceId> <text> [waitMs]      types text + Enter, prints the screen
//   tsx scripts/verify.ts screen <workspaceId>
//   tsx scripts/verify.ts park <workspaceId>
//   tsx scripts/verify.ts close <workspaceId>
//   tsx scripts/verify.ts rtt <workspaceId> [count]               echo and heartbeat round trips
//   tsx scripts/verify.ts wrong-key | no-auth | agent-auth
//   tsx scripts/verify.ts device-key                              the device key file's fingerprint
//   tsx scripts/verify.ts device-gate                             unknown keys, with and without a token proof
//   tsx scripts/verify.ts no-device                               a client without a device key (refused)
//   tsx scripts/verify.ts idle <workspaceId> [seconds]            silent while attached, then checks the echo
//   tsx scripts/verify.ts outage <workspaceId> [seconds]          stays attached, reports each drop and recovery
//   tsx scripts/verify.ts media <path> [workspaceId] [out]        reads a preview inside the session; with a
//                                                                  workspace, measures the echo meanwhile
//   tsx scripts/verify.ts browser <session> [workspaceId] [seconds] streams a browser view inside the session
//   tsx scripts/verify.ts clientlog [kind]                        flushes one connection-log event inside the session
//   tsx scripts/verify.ts pair '<pairing link>'                   pairs a new device with a `perch pair` link, reconnects
//                                                                  it with no token, then tries the spent code again.
//                                                                  It enrols a throwaway key: revoke it afterwards
//   tsx scripts/verify.ts join-gate <relay URL>                   joins and lists without the join key, or with a wrong one
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import {
  IkInitiator,
  SecureSession,
  b64url,
  deviceFingerprint,
  ed25519Signer,
  encodeDeviceHello,
  signDeviceHello,
  enrolKey,
  enrolProof,
  JOIN_HEADER,
  accountId,
  generateAgentKeys,
  generateDeviceKeys,
  generateJoinKey,
  parsePairingLink,
  signJoinAuth,
  handshakeFrame,
  rawStaticKey,
  readHandshakeFrame,
  signAgentAuth,
  signDeviceAuth,
  type DeviceKeys,
} from '@perch/secure-channel';

interface Connection {
  send(message: Record<string, unknown>): void;
  next(match: (m: Message) => boolean, timeoutMs?: number): Promise<Message>;
  onMessage(listener: (m: Message) => void): void;
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

type Message = { type: string; [key: string]: unknown };

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

// How the client presents itself to the relay and the agent: a device key (IK), with or without
// an enrolment proof.
interface Device {
  keys: DeviceKeys;
  // The secret the enrolment proof is made with, and what it is; none sends no proof.
  proof?: { secret: string; cred: 'token' | 'pairing' };
}

const token = () => process.env.PERCH_TOKEN ?? '';

async function loadDevice(): Promise<Device> {
  const path = process.env.DEVICE_KEY_FILE || join(homedir(), '.perch', 'verify-device.json');
  let keys: DeviceKeys;
  try {
    keys = JSON.parse(await readFile(path, 'utf8')) as DeviceKeys;
  } catch {
    keys = generateDeviceKeys();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(keys, null, 2), { mode: 0o600, flag: 'wx' });
  }
  return { keys, ...(token() ? { proof: { secret: token(), cred: 'token' as const } } : {}) };
}

// The relay URL with the device's signature over a fresh challenge, as the PWA builds it.
async function deviceUrl(url: string, device: Device): Promise<string> {
  const target = new URL(url);
  const account = target.pathname.slice(1);
  const res = await fetch(`${target.origin.replace(/^ws/, 'http')}/${account}?role=challenge`);
  if (!res.ok) throw new Error(`challenge: HTTP ${res.status}`);
  const { nonce } = (await res.json()) as { nonce: string };
  const claim = { account, nonce, device: device.keys.ed25519.publicKey };
  target.searchParams.set('device', claim.device);
  target.searchParams.set('nonce', nonce);
  target.searchParams.set('sig', await signDeviceAuth(ed25519Signer(device.keys.ed25519.privateKey), claim));
  if (device.proof) {
    target.searchParams.set('proof', enrolProof(enrolKey(device.proof.secret, account), claim));
    target.searchParams.set('cred', device.proof.cred);
  }
  return target.toString();
}

async function open(url: string, agentKey: string, device: Device): Promise<Connection> {
  const target = await deviceUrl(url, device);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target);
    const listeners: Array<(m: Message) => void> = [];
    const closed = new Promise<{ code: number; reason: string }>((r) =>
      socket.once('close', (code, reason) => r({ code, reason: reason.toString() })),
    );
    socket.once('unexpected-response', (_req, res) => reject(new Error(`refused at the relay: HTTP ${res.statusCode}`)));
    socket.once('error', reject);
    // A no-op once resolved; before that, the relay (in band) or the agent refused this client.
    void closed.then(({ code, reason }) => reject(new Error(`refused before the session was up: ${code} ${reason}`)));
    let session: SecureSession | null = null;
    const deliver = (text: string) => {
      const message = JSON.parse(text) as Message;
      listeners.forEach((l) => l(message));
    };
    const connection: Connection = {
      send: (message) => {
        for (const frame of session!.seal(new TextEncoder().encode(JSON.stringify(message)))) socket.send(frame);
      },
      next: (match, timeoutMs = 15_000) =>
        new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timed out waiting for a message')), timeoutMs);
          void closed.then(({ code, reason }) => {
            clearTimeout(timer);
            rej(new Error(`closed while waiting for a message: ${code} ${reason}`));
          });
          const listener = (m: Message) => {
            if (!match(m)) return;
            clearTimeout(timer);
            listeners.splice(listeners.indexOf(listener), 1);
            res(m);
          };
          listeners.push(listener);
        }),
      onMessage: (listener) => void listeners.push(listener),
      closed,
      close: () => socket.close(),
    };
    socket.once('open', () => {
      const ik = new IkInitiator(rawStaticKey(b64url.decode(device.keys.x25519.privateKey)), b64url.decode(agentKey));
      socket.once('message', async (data: Buffer) => {
        try {
          await ik.readMessage2(readHandshakeFrame(new Uint8Array(data), 'ik'));
        } catch {
          socket.close();
          reject(new Error('agent key mismatch'));
          return;
        }
        const { send, recv } = ik.split();
        session = new SecureSession(send, recv);
        socket.on('message', (frame: Buffer) => {
          const message = session!.open(new Uint8Array(frame));
          if (message) deliver(new TextDecoder().decode(message));
        });
        resolve(connection);
      });
      const keys = device.keys;
      const hello = async (hash: Uint8Array) =>
        encodeDeviceHello({
          sig: keys.ed25519.publicKey,
          name: 'verify.ts',
          proof: await signDeviceHello(ed25519Signer(keys.ed25519.privateKey), b64url.decode(keys.x25519.publicKey), hash),
        });
      void ik.writeMessage1(hello).then((m1) => socket.send(handshakeFrame(m1, 'ik')));
    });
  });
}

async function connect(device?: Device): Promise<Connection> {
  const conn = await open(env('PERCH_URL'), env('AGENT_KEY'), device ?? (await loadDevice()));
  return authenticate(conn, token());
}

async function authenticate(conn: Connection, token: string): Promise<Connection> {
  const result = conn.next((m) => m.type === 'authResult');
  conn.send({ type: 'auth', token });
  const { ok } = (await result) as unknown as { ok: boolean };
  if (!ok) throw new Error('auth rejected');
  return conn;
}

const decode = (data: unknown) => Buffer.from(String(data), 'base64').toString('utf8');
// Terminal bytes are base64 on the wire in both directions.
const input = (id: string, text: string) => ({ type: 'input', workspaceId: id, data: Buffer.from(text).toString('base64') });
// Enough of a terminal to read the screen in a log: drop escape sequences and control bytes.
const plain = (text: string) =>
  text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

async function attach(conn: Connection, id: string): Promise<{ output: () => string }> {
  let buffer = '';
  conn.onMessage((m) => {
    if (m.type === 'output' && m.workspaceId === id) buffer += decode(m.data);
  });
  const attached = conn.next((m) => m.type === 'attached' && m.workspaceId === id);
  conn.send({ type: 'attach', workspaceId: id, cols: 120, rows: 40 });
  await attached;
  return { output: () => buffer };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return `n=${sorted.length} median=${at(0.5).toFixed(1)}ms p90=${at(0.9).toFixed(1)}ms min=${sorted[0]!.toFixed(1)}ms`;
}

async function workspaces(conn: Connection): Promise<Array<{ id: string; name: string; status: string; command: string }>> {
  const reply = conn.next((m) => m.type === 'workspaces');
  conn.send({ type: 'list' });
  return (await reply).workspaces as Array<{ id: string; name: string; status: string; command: string }>;
}

// Types 'x' into the workspace every 150 ms while `busy` holds and returns the echo times, to
// show whether a side channel delays terminal output.
async function echoWhile(conn: Connection, id: string, busy: () => boolean): Promise<number[]> {
  let lastOutput = 0;
  conn.onMessage((m) => {
    if (m.type === 'output' && m.workspaceId === id) lastOutput = performance.now();
  });
  await attach(conn, id);
  await sleep(500);
  const echo: number[] = [];
  while (busy()) {
    const before = lastOutput;
    const sent = performance.now();
    conn.send(input(id, 'x'));
    while (lastOutput === before && performance.now() - sent < 10_000) await sleep(1);
    echo.push(lastOutput - sent);
    await sleep(150);
  }
  conn.send(input(id, '\x15'));
  return echo;
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async list() {
    const conn = await connect();
    for (const w of await workspaces(conn)) console.log(`${w.id}\t${w.status}\t${w.name}\t${w.command}`);
    conn.close();
  },

  async create([projectPath, command]) {
    const conn = await connect();
    const before = new Set((await workspaces(conn)).map((w) => w.id));
    conn.send({ type: 'create', projectPath: projectPath!, command: command! });
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      const created = (await workspaces(conn)).find((w) => !before.has(w.id));
      if (created) {
        console.log(created.id);
        conn.close();
        return;
      }
    }
    throw new Error('workspace did not appear');
  },

  async send([id, text, waitMs]) {
    const conn = await connect();
    const screen = await attach(conn, id!);
    await sleep(500);
    conn.send(input(id!, text!));
    await sleep(150);
    conn.send(input(id!, '\r'));
    await sleep(Number(waitMs ?? 1500));
    console.log(plain(screen.output()).slice(-2000));
    conn.close();
  },

  async screen([id]) {
    const conn = await connect();
    const screen = await attach(conn, id!);
    await sleep(1500);
    console.log(plain(screen.output()).slice(-3000));
    conn.close();
  },

  async park([id]) {
    const conn = await connect();
    const reply = conn.next((m) => (m.type === 'workspaceUpdated' && (m.workspace as { id: string }).id === id) || m.type === 'error');
    conn.send({ type: 'setStatus', workspaceId: id!, status: 'parked' });
    console.log(JSON.stringify(await reply));
    conn.close();
  },

  async close([id]) {
    const conn = await connect();
    const reply = conn.next((m) => m.type === 'closed' && m.workspaceId === id);
    conn.send({ type: 'close', workspaceId: id! });
    await reply;
    console.log(`closed ${id}`);
    conn.close();
  },

  async rtt([id, count]) {
    const n = Number(count ?? 30);
    const conn = await connect();
    let lastOutput = 0;
    conn.onMessage((m) => {
      if (m.type === 'output' && m.workspaceId === id) lastOutput = performance.now();
    });
    await attach(conn, id!);
    await sleep(1000);
    const echo: number[] = [];
    for (let i = 0; i < n; i++) {
      const before = lastOutput;
      const sent = performance.now();
      conn.send(input(id!, 'x'));
      while (lastOutput === before) await sleep(1);
      echo.push(lastOutput - sent);
      await sleep(150);
    }
    conn.send(input(id!, '\x15'));
    const heartbeat: number[] = [];
    for (let i = 0; i < n; i++) {
      const pong = conn.next((m) => m.type === 'pong');
      const sent = performance.now();
      conn.send({ type: 'ping' });
      await pong;
      heartbeat.push(performance.now() - sent);
      await sleep(100);
    }
    console.log(`echo      ${stats(echo)}`);
    console.log(`heartbeat ${stats(heartbeat)}`);
    conn.close();
  },

  async 'wrong-key'() {
    try {
      await open(env('PERCH_URL'), generateAgentKeys().x25519.publicKey, await loadDevice());
      console.log('FAIL: the handshake completed against the wrong key');
    } catch (err) {
      console.log(`refused: ${(err as Error).message}`);
    }
  },

  // Completes the handshake, then never authenticates: the agent must close within its deadline.
  async 'no-auth'() {
    const conn = await open(env('PERCH_URL'), env('AGENT_KEY'), await loadDevice());
    const started = Date.now();
    const closed = await Promise.race([conn.closed, sleep(20_000).then(() => null)]);
    if (!closed) {
      console.log('FAIL: still open 20 s after the handshake without auth');
      conn.close();
      return;
    }
    console.log(`closed after ${((Date.now() - started) / 1000).toFixed(1)} s: ${closed.code} ${closed.reason}`);
  },

  async 'device-key'() {
    const device = await loadDevice();
    console.log(`device ${deviceFingerprint(device.keys.x25519.publicKey)} (${process.env.DEVICE_KEY_FILE})`);
  },

  // Fresh, never-enrolled device keys: without a token proof the relay must refuse them itself;
  // with a proof made from a wrong token the agent must refuse the enrolment.
  async 'device-gate'() {
    const attempt = async (label: string, device: Device) => {
      try {
        const conn = await connect(device);
        console.log(`FAIL: ${label}: served`);
        conn.close();
      } catch (err) {
        console.log(`${label}: ${(err as Error).message}`);
      }
    };
    await attempt('unknown key, no token proof', { keys: generateDeviceKeys() });
    await attempt('unknown key, proof from a wrong token', { keys: generateDeviceKeys(), proof: { secret: 'not-the-token', cred: 'token' } });
  },

  // Enrols this client's own device key with a `perch pair` code, so every other command
  // authenticates with the key alone.
  async enrol() {
    const link = parsePairingLink(process.argv[3] ?? '');
    if (!link) throw new Error('usage: verify.ts enrol <pairing link>');
    const { keys } = await loadDevice();
    const conn = await authenticate(await open(link.url, link.agentKey, { keys, proof: { secret: link.secret, cred: 'pairing' } }), link.secret);
    console.log(`enrolled device ${deviceFingerprint(keys.x25519.publicKey)}: ${(await workspaces(conn)).length} workspaces`);
    console.log(`PERCH_URL=${link.url}\nAGENT_KEY=${link.agentKey}`);
    conn.close();
  },

  // A new phone paired with a `perch pair` link: no token anywhere. The code enrols its key, the
  // key alone then authenticates it, and the spent code admits no second device.
  async pair() {
    const link = parsePairingLink(process.argv[3] ?? '');
    if (!link) throw new Error('usage: verify.ts pair <pairing link>');
    const phone: Device = { keys: generateDeviceKeys(), proof: { secret: link.secret, cred: 'pairing' } };
    const first = await authenticate(await open(link.url, link.agentKey, phone), link.secret);
    console.log(`paired with the code: ${(await workspaces(first)).length} workspaces, device ${deviceFingerprint(phone.keys.x25519.publicKey)}`);
    first.close();
    await new Promise((r) => setTimeout(r, 500));
    const again = await authenticate(await open(link.url, link.agentKey, { keys: phone.keys }), '');
    console.log(`reconnected with no token and no code: ${(await workspaces(again)).length} workspaces`);
    again.close();
    try {
      const late = await authenticate(await open(link.url, link.agentKey, { keys: generateDeviceKeys(), proof: { secret: link.secret, cred: 'pairing' } }), link.secret);
      console.log('FAIL: a second device got in with the spent code');
      late.close();
    } catch (err) {
      console.log(`second device with the spent code: ${(err as Error).message}`);
    }
  },

  // Registering or listing without the relay's join key, or with a wrong one.
  async 'join-gate'() {
    const relay = (process.argv[3] ?? '').replace(/^ws/, 'http').replace(/\/+$/, '');
    if (!relay) throw new Error('usage: verify.ts join-gate <relay URL>');
    const agent = generateAgentKeys();
    const account = accountId(agent.ed25519.publicKey);
    const now = Date.now();
    const authorization = signAgentAuth(agent.ed25519.privateKey, { account, role: 'join' }, now);
    const attempt = async (label: string, method: 'GET' | 'POST', path: string, headers: Record<string, string>) => {
      const res = await fetch(`${relay}${path}`, { method, headers });
      console.log(`${label}: HTTP ${res.status}${res.status < 400 ? ' FAIL' : ''}`);
    };
    const joinPath = `/${account}?role=join&key=${agent.ed25519.publicKey}`;
    await attempt('join, agent signature only', 'POST', joinPath, { authorization });
    await attempt('join, wrong join key', 'POST', joinPath, { authorization, [JOIN_HEADER]: signJoinAuth(generateJoinKey(), { account, role: 'join' }, now) });
    await attempt('list, wrong admin key', 'GET', '/?role=machines', { [JOIN_HEADER]: signJoinAuth(generateJoinKey(), { account: '*', role: 'machines' }, now) });
    await attempt('the account afterwards', 'GET', `/${account}`, {});
  },

  // A client that upgrades without a device key: the relay must refuse it in band.
  async 'no-device'() {
    const socket = new WebSocket(env('PERCH_URL'));
    socket.once('unexpected-response', (_req, res) => console.log(`refused at the relay: HTTP ${res.statusCode}`));
    socket.once('error', () => undefined);
    const { code, reason } = await new Promise<{ code: number; reason: string }>((r) =>
      socket.once('close', (c, why) => r({ code: c, reason: why.toString() })),
    );
    console.log(code >= 4400 && code < 4500 ? `refused: ${code} ${reason}` : `FAIL: closed ${code} ${reason}`);
  },

  // The agent role, attempted by someone without the agent's signing key.
  async 'agent-auth'() {
    const url = new URL(env('PERCH_URL'));
    const account = url.pathname.slice(1);
    const stranger = generateAgentKeys();
    const attempt = (label: string, query: string, headers: Record<string, string>) =>
      new Promise<void>((resolve) => {
        const socket = new WebSocket(`${url.origin}/${account}${query}`, { headers });
        socket.once('open', () => {
          console.log(`FAIL: ${label} was accepted`);
          socket.close();
          resolve();
        });
        socket.once('unexpected-response', (_req, res) => {
          console.log(`${label}: HTTP ${res.statusCode}`);
          resolve();
        });
        socket.once('error', () => resolve());
      });
    await attempt('control without credentials', '?role=agent', {});
    await attempt('control signed by another key', '?role=agent', {
      authorization: signAgentAuth(stranger.ed25519.privateKey, { account, role: 'agent' }, Date.now()),
    });
    await attempt('dial signed by another key', '?role=dial', {
      authorization: signAgentAuth(stranger.ed25519.privateKey, { account, role: 'dial', dialId: 'x' }, Date.now()),
      'x-perch-dial': 'x',
    });
    await attempt('dial without credentials', '?role=dial', { 'x-perch-dial': 'x' });
  },

  // Stays attached and silent (so the relay can hibernate), then checks the pair still echoes.
  async idle([id, seconds]) {
    const conn = await connect();
    let lastOutput = 0;
    conn.onMessage((m) => {
      if (m.type === 'output' && m.workspaceId === id) lastOutput = performance.now();
    });
    await attach(conn, id!);
    const dropped = await Promise.race([conn.closed, sleep(Number(seconds ?? 60) * 1000).then(() => null)]);
    if (dropped) {
      console.log(`FAIL: dropped while idle: ${dropped.code} ${dropped.reason}`);
      return;
    }
    const before = lastOutput;
    const sent = performance.now();
    conn.send(input(id!, 'x'));
    const deadline = sent + 10_000;
    while (lastOutput === before && performance.now() < deadline) await sleep(1);
    console.log(lastOutput === before ? 'FAIL: no echo after idling' : `echo after idling: ${(lastOutput - sent).toFixed(1)}ms`);
    conn.send(input(id!, '\x15'));
    await sleep(300);
    conn.close();
  },

  async media([path, id, out]) {
    const conn = await connect();
    let done = false;
    const echo = id ? echoWhile(conn, id, () => !done) : Promise.resolve([]);
    if (id) await sleep(1500);
    const started = performance.now();
    const parts: Buffer[] = [];
    let chunks = 0;
    let received = 0;
    // Chunks can arrive in the same tick as the header, so both are handled in one listener.
    const finished = new Promise<{ result: string; mediaType?: string; size: number }>((resolve) => {
      let header: { result: string; mediaType?: string; size: number } | null = null;
      conn.onMessage((m) => {
        if (m.id !== 'v1') return;
        if (m.type === 'media') {
          header = { result: String(m.result), mediaType: m.mediaType as string | undefined, size: Number(m.size ?? 0) };
        } else if (m.type === 'mediaChunk') {
          parts.push(Buffer.from(String(m.data), 'base64'));
          received += parts.at(-1)!.length;
          chunks += 1;
          conn.send({ type: 'mediaAck', id: 'v1', seq: m.seq });
        } else {
          return;
        }
        if (header && (header.result !== 'ok' || received >= header.size)) resolve(header);
      });
    });
    conn.send({ type: 'readMedia', id: 'v1', path: path! });
    const { result, mediaType, size } = await Promise.race([
      finished,
      sleep(120_000).then(() => {
        throw new Error(`media stalled after ${received} bytes`);
      }),
    ]);
    if (result !== 'ok') {
      console.log(`media ${result}`);
      done = true;
      await echo;
      conn.close();
      return;
    }
    const ms = performance.now() - started;
    done = true;
    const bytes = Buffer.concat(parts);
    console.log(
      `media ok ${mediaType} ${bytes.length}/${size} bytes in ${chunks} chunks, ${ms.toFixed(0)}ms, sha256 ${createHash('sha256').update(bytes).digest('hex')}`,
    );
    if (out) await writeFile(out, bytes);
    const samples = await echo;
    if (samples.length) console.log(`echo during the transfer ${stats(samples)}`);
    conn.close();
  },

  async browser([session, id, seconds]) {
    const conn = await connect();
    const until = performance.now() + Number(seconds ?? 10) * 1000;
    const echo = id ? echoWhile(conn, id, () => performance.now() < until) : Promise.resolve([]);
    let frames = 0;
    let bytes = 0;
    const other: string[] = [];
    let closed = false;
    conn.onMessage((m) => {
      if (m.stream !== 'v1') return;
      if (m.type === 'browserClosed') closed = true;
      if (m.type !== 'browser') return;
      const inner = JSON.parse(String(m.data)) as { type: string; reason?: string };
      if (inner.type === 'frame') {
        frames += 1;
        bytes += String(m.data).length;
      } else {
        other.push(inner.reason ? `${inner.type}:${inner.reason}` : inner.type);
      }
      conn.send({ type: 'browserAck', stream: 'v1' });
    });
    conn.send({ type: 'browserOpen', stream: 'v1', session: session! });
    // The session is already authenticated: the stream's token is never checked.
    conn.send({ type: 'browser', stream: 'v1', data: JSON.stringify({ type: 'auth', token: '' }) });
    while (performance.now() < until && !closed) await sleep(100);
    conn.send({ type: 'browserClose', stream: 'v1' });
    console.log(`browser ${frames} frames, ${(bytes / 1024).toFixed(0)} KiB; other: ${other.join(' ') || 'none'}${closed ? '; closed by the agent' : ''}`);
    const samples = await echo;
    if (samples.length) console.log(`echo while streaming ${stats(samples)}`);
    conn.close();
  },

  async clientlog([kind]) {
    const conn = await connect();
    const ack = conn.next((m) => m.type === 'clientLogAck');
    const event = { sess: `verify-${Date.now()}`, seq: 0, t: Date.now(), kind: kind ?? 'verify', online: true, vis: 'visible' };
    conn.send({ type: 'clientLog', id: 'v1', batch: { shell: 'verify', events: [event] } });
    console.log(`clientLogAck ok=${String((await ack).ok)} sess=${event.sess}`);
    conn.close();
  },

  // Stays attached and pinging; on every drop, reconnects and re-attaches like the PWA does.
  async outage([id, seconds]) {
    const until = Date.now() + Number(seconds ?? 120) * 1000;
    while (Date.now() < until) {
      let conn: Connection;
      try {
        conn = await connect();
        await attach(conn, id!);
      } catch (err) {
        console.log(`${new Date().toISOString()} connect failed: ${(err as Error).message}`);
        await sleep(500);
        continue;
      }
      console.log(`${new Date().toISOString()} attached`);
      const drop = conn.closed.then((c) => c);
      const pinger = setInterval(() => conn.send({ type: 'ping' }), 1000);
      const result = await Promise.race([drop, sleep(Math.max(0, until - Date.now())).then(() => null)]);
      clearInterval(pinger);
      if (!result) {
        conn.close();
        break;
      }
      console.log(`${new Date().toISOString()} dropped code=${result.code} ${result.reason}`);
    }
  },
};

const [name, ...args] = process.argv.slice(2);
const command = name ? commands[name] : undefined;
if (!command) {
  console.error(`usage: verify.ts <${Object.keys(commands).join('|')}> …`);
  process.exit(2);
}
command(args).then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
