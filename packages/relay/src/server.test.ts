import { describe, it, expect, afterEach, vi } from 'vitest';
import { connect } from 'node:net';
import { WebSocket } from 'ws';
import { accountId, generateAgentKeys, signAgentAuth } from '@perch/secure-channel';
import { MemoryRegistry } from './registry.ts';
import { startRelayServer, type RelayServer } from './server.ts';

const keys = generateAgentKeys();
const ACCOUNT = accountId(keys.ed25519.publicKey);
const registry = () => new MemoryRegistry({ accounts: { [ACCOUNT]: { key: keys.ed25519.publicKey, addedAt: 'then' } } });

function agentHeaders(role: 'agent' | 'dial', dialId?: string): Record<string, string> {
  const authorization = signAgentAuth(keys.ed25519.privateKey, { account: ACCOUNT, role, dialId }, Date.now());
  return dialId ? { authorization, 'x-perch-dial': dialId } : { authorization };
}

function start(): Promise<RelayServer> {
  return startRelayServer({ port: 0, host: '127.0.0.1', registry: registry() });
}

let server: RelayServer | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  sockets.forEach((s) => s.terminate());
  sockets.length = 0;
  await server?.close();
  server = null;
});

function open(url: string, headers?: Record<string, string>): WebSocket {
  const socket = new WebSocket(url, { headers });
  socket.on('error', () => undefined);
  sockets.push(socket);
  return socket;
}

function once<T>(socket: WebSocket, event: string): Promise<T[]> {
  return new Promise((resolve) => socket.once(event, (...args: T[]) => resolve(args)));
}

// RFC 6455's example key, derived rather than written out so it doesn't read as a credential.
const sampleKey = Buffer.from('the sample nonce').toString('base64');
const validHeaders = `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${sampleKey}\r\nSec-WebSocket-Version: 13\r\n`;

// Sends a hand-written upgrade request and returns the first bytes of the reply.
function rawUpgrade(port: number, path: string, headers: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: relay\r\n${headers}\r\n`);
    });
    let reply = '';
    socket.on('data', (chunk) => {
      reply += String(chunk);
      socket.destroy();
      resolve(reply);
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(reply));
  });
}

describe('relay server joining', () => {
  it('answers 501 to a join when it has no join key, so the machine can say joining is off', async () => {
    server = await start();
    const res = await fetch(`http://127.0.0.1:${server.port}/${ACCOUNT}?role=join&key=${keys.ed25519.publicKey}`, { method: 'POST' });
    expect(res.status).toBe(501);
  });
});

describe('relay server', () => {
  it('survives an upgrade whose path the URL parser cannot read', async () => {
    server = await start();
    for (const path of ['//[', '//a^b', '//a%zz']) {
      expect(await rawUpgrade(server.port, path, validHeaders)).toMatch(/^HTTP\/1\.1 404/);
    }
    const res = await fetch(`http://127.0.0.1:${server.port}/up`);
    expect(res.status).toBe(200);
  });

  it('rejects an invalid handshake before asking the agent to dial', async () => {
    server = await start();
    const base = `ws://127.0.0.1:${server.port}/${ACCOUNT}`;
    const dials: string[] = [];
    const control = open(`${base}?role=agent`, agentHeaders('agent'));
    control.on('message', (raw) => dials.push(String(raw)));
    await once(control, 'open');
    const noKey = 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n';
    expect(await rawUpgrade(server.port, `/${ACCOUNT}`, noKey)).toMatch(/^HTTP\/1\.1 400/);
    const badVersion = validHeaders.replace('Version: 13', 'Version: 99');
    expect(await rawUpgrade(server.port, `/${ACCOUNT}`, badVersion)).toMatch(/^HTTP\/1\.1 400/);
    // Anything the relay sent the agent before reading this heartbeat arrives ahead of its answer.
    control.send('ping');
    await new Promise((r) => control.once('message', r));
    expect(dials).toEqual(['pong']);
  });
});

describe('relay server, exposed behind a proxy', () => {
  const limits = { dialTimeoutMs: 2000, maxPending: 8, maxPairs: 8 };

  // The tests connect from loopback, as a proxy on the relay's machine does, and name the client
  // in this header.
  function startExposed(options: Partial<Parameters<typeof startRelayServer>[0]> = {}): Promise<RelayServer> {
    return startRelayServer({ port: 0, host: '127.0.0.1', registry: registry(), limits, clientIpHeader: 'cf-connecting-ip', ...options });
  }

  // Resolves with the upgrade's status once it is answered; a pending client stays unanswered.
  function upgradeStatus(url: string, headers?: Record<string, string>): { settled: Promise<number>; socket: WebSocket } {
    const socket = open(url, headers);
    const settled = new Promise<number>((resolve) => {
      socket.once('open', () => resolve(101));
      socket.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    });
    return { settled, socket };
  }

  // A phone's refusal is made in band: the upgrade opens, then closes at once with a 44xx/45xx code.
  function refusalCode(url: string, headers?: Record<string, string>): Promise<number> {
    const socket = open(url, headers);
    return new Promise((resolve) => {
      socket.once('close', (code) => resolve(code));
      socket.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    });
  }

  async function controlSocket(base: string): Promise<{ socket: WebSocket; dials: string[] }> {
    const dials: string[] = [];
    const socket = open(`${base}?role=agent`, agentHeaders('agent'));
    socket.on('message', (raw) => dials.push(String(raw)));
    await once(socket, 'open');
    return { socket, dials };
  }

  const until = async (check: () => boolean, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('condition not met');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('caps the connections of one client address, taken from the configured header', async () => {
    server = await startExposed({ connections: { maxConnections: 50, maxPerAddress: 3 } });
    const base = `ws://127.0.0.1:${server.port}/${ACCOUNT}`;
    const { dials } = await controlSocket(base);
    const from = (ip: string) => ({ 'cf-connecting-ip': ip });
    const held = [1, 2, 3].map(() => upgradeStatus(base, from('203.0.113.7')));
    await until(() => dials.length === 3);
    expect(await upgradeStatus(base, from('203.0.113.7')).settled).toBe(429);
    const other = upgradeStatus(base, from('198.51.100.2'));
    await until(() => dials.length === 4);
    held[0]!.socket.terminate();
    other.socket.terminate();
    await until(() => server!.stats().connections === 3, 500);
    const again = upgradeStatus(base, from('203.0.113.7'));
    await until(() => dials.length === 5);
    again.socket.terminate();
  });

  it('by default, refuses one address before it can fill an account\'s pending slots', async () => {
    const lines: string[] = [];
    server = await startExposed({ log: (line) => lines.push(line) });
    const base = `ws://127.0.0.1:${server.port}/${ACCOUNT}`;
    const { dials } = await controlSocket(base);
    const flood = { 'cf-connecting-ip': '203.0.113.66' };
    const held = [];
    for (let i = 0; i < limits.maxPending; i += 1) held.push(upgradeStatus(base, flood));
    await until(() => lines.length > 0);
    await until(() => dials.length === 6);
    expect(lines).toEqual(['relay refused 429 (too many connections) from 203.0.113.66']);
    upgradeStatus(base, { 'cf-connecting-ip': '198.51.100.20' });
    await until(() => dials.length === 7);
  });

  it('trusts no client-IP header unless one is configured', async () => {
    server = await startExposed({ clientIpHeader: undefined, connections: { maxConnections: 50, maxPerAddress: 1 } });
    const base = `ws://127.0.0.1:${server.port}/${ACCOUNT}`;
    const { dials } = await controlSocket(base);
    const forged = { 'cf-connecting-ip': '203.0.113.7' };
    upgradeStatus(base, forged);
    upgradeStatus(base, forged);
    await until(() => dials.length === 2);
  });

  // Behind a local proxy with no header configured, every client arrives from loopback: a cap on
  // that one address would let any client lock every other one out, the owner included.
  it('counts loopback clients against the host only when no header names them', async () => {
    server = await startExposed({ clientIpHeader: undefined, connections: { maxConnections: 4, maxPerAddress: 1 } });
    const base = `ws://127.0.0.1:${server.port}/${ACCOUNT}`;
    const { dials } = await controlSocket(base);
    for (let i = 0; i < 3; i += 1) upgradeStatus(base);
    await until(() => dials.length === 3);
    expect(await upgradeStatus(base).settled).toBe(429);
  });

  it('reads the address a proxy appended to X-Forwarded-For, not the one the client wrote', async () => {
    server = await startExposed({ clientIpHeader: 'x-forwarded-for', connections: { maxConnections: 50, maxPerAddress: 1 } });
    const base = `ws://127.0.0.1:${server.port}/${ACCOUNT}`;
    const { dials } = await controlSocket(base);
    upgradeStatus(base, { 'x-forwarded-for': '198.51.100.1, 203.0.113.7' });
    await until(() => dials.length === 1);
    expect(await upgradeStatus(base, { 'x-forwarded-for': '198.51.100.2, 203.0.113.7' }).settled).toBe(429);
    upgradeStatus(base, { 'x-forwarded-for': '203.0.113.7, 198.51.100.3' });
    await until(() => dials.length === 2);
  });

  it('frees the pending slot of a client that gives up before its dial', async () => {
    server = await startExposed({ limits: { ...limits, maxPending: 2 } });
    const base = `ws://127.0.0.1:${server.port}/${ACCOUNT}`;
    const { dials } = await controlSocket(base);
    const first = upgradeStatus(base);
    upgradeStatus(base);
    await until(() => dials.length === 2);
    first.socket.terminate();
    await until(() => server!.stats().connections === 2, 500);
    upgradeStatus(base);
    await until(() => dials.length === 3, 500);
  });

  it('does not count the agent against the address it shares with a phone at home', async () => {
    server = await startExposed({ connections: { maxConnections: 50, maxPerAddress: 1 } });
    const base = `ws://127.0.0.1:${server.port}/${ACCOUNT}`;
    const home = { 'cf-connecting-ip': '203.0.113.50' };
    const dials: string[] = [];
    const control = open(`${base}?role=agent`, { ...agentHeaders('agent'), ...home });
    control.on('message', (raw) => dials.push(String(raw)));
    await once(control, 'open');
    const phone = upgradeStatus(base, home);
    await until(() => dials.length === 1);
    const { id } = JSON.parse(dials[0]!) as { id: string };
    const dialed = open(`${base}?role=dial`, { ...agentHeaders('dial', id), ...home });
    await once(dialed, 'open');
    expect(await phone.settled).toBe(101);
  });

  it('caps the connections of the whole host, whatever the address', async () => {
    server = await startExposed({ connections: { maxConnections: 3, maxPerAddress: 10 } });
    const base = `ws://127.0.0.1:${server.port}/${ACCOUNT}`;
    const { dials } = await controlSocket(base);
    upgradeStatus(base, { 'cf-connecting-ip': '198.51.100.1' });
    upgradeStatus(base, { 'cf-connecting-ip': '198.51.100.2' });
    await until(() => dials.length === 2);
    expect(await upgradeStatus(base, { 'cf-connecting-ip': '198.51.100.3' }).settled).toBe(429);
    const res = await fetch(`http://127.0.0.1:${server.port}/up`);
    expect(res.status).toBe(200);
  });

  // Before a request is read, nothing knows its address or its role: an idle TCP connection
  // holds a file descriptor all the same.
  it('caps the raw connections of the whole host, before any request is read', async () => {
    server = await startExposed({ connections: { maxConnections: 3, maxPerAddress: 10, maxSockets: 2 } });
    const port = server.port;
    const idle = await Promise.all(
      [0, 1].map(
        () =>
          new Promise<ReturnType<typeof connect>>((resolve) => {
            const socket = connect(port, '127.0.0.1', () => resolve(socket));
            socket.on('error', () => undefined);
          }),
      ),
    );
    await new Promise((r) => setTimeout(r, 50));
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.on('error', () => resolve(true));
      socket.on('close', () => resolve(true));
      socket.on('data', () => resolve(false));
      socket.on('connect', () => socket.write('GET /up HTTP/1.1\r\nHost: relay\r\n\r\n'));
    });
    expect(refused).toBe(true);
    idle.forEach((socket) => socket.destroy());
    // Served again once the server has seen the idle sockets go.
    await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${port}/up`)).status).toBe(200));
  });

  it('holds nothing for an account it does not serve', async () => {
    server = await startExposed();
    for (let i = 0; i < 20; i += 1) {
      expect(await refusalCode(`ws://127.0.0.1:${server.port}/guess-${i}`)).toBe(4404);
      expect((await fetch(`http://127.0.0.1:${server.port}/guess-${i}?role=challenge`)).status).toBe(404);
    }
    await until(() => server!.stats().connections === 0);
    expect(server.stats().accounts).toBe(0);
  });

  // A refused phone's socket is closed in band, and a client that never answers the close frame
  // must not keep its slot until the heartbeat ends it: a stream of such refusals would fill the
  // host and lock out the owner and the agent.
  it('frees the slot of a refused upgrade whose client never answers the close', async () => {
    server = await startExposed({ heartbeatMs: 60_000 });
    const port = server.port;
    const silent = await Promise.all(
      [0, 1, 2].map(
        (i) =>
          new Promise<ReturnType<typeof connect>>((resolve) => {
            const socket = connect(port, '127.0.0.1', () =>
              socket.write(`GET /guess-${i} HTTP/1.1\r\nHost: relay\r\n${validHeaders}\r\n`),
            );
            socket.on('error', () => undefined);
            // Reads the 101 and the close frame, and never writes another byte.
            socket.once('data', () => resolve(socket));
          }),
      ),
    );
    expect(server.stats().connections).toBe(3);
    await until(() => server!.stats().connections === 0, 2500);
    silent.forEach((socket) => socket.destroy());
  });

  it("keeps slots for the agent's own sockets when phones fill the host", async () => {
    server = await startExposed({ connections: { maxConnections: 2, maxPerAddress: 10, agentReserve: 2 } });
    const base = `ws://127.0.0.1:${server.port}/${ACCOUNT}`;
    const { dials } = await controlSocket(base);
    // The control socket and this phone fill the host.
    upgradeStatus(base, { 'cf-connecting-ip': '198.51.100.1' });
    await until(() => dials.length === 1);
    expect(await upgradeStatus(base, { 'cf-connecting-ip': '198.51.100.2' }).settled).toBe(429);
    const { id } = JSON.parse(dials[0]!) as { id: string };
    expect(await upgradeStatus(`${base}?role=dial`, agentHeaders('dial', id)).settled).toBe(101);
  });

  it('bounds the trace a flood of challenges can write', async () => {
    const lines: string[] = [];
    server = await startExposed({ trace: (line) => lines.push(line) });
    for (let i = 0; i < 80; i += 1) await fetch(`http://127.0.0.1:${server.port}/guess?role=challenge`);
    expect(lines.length).toBeLessThanOrEqual(30);
  });

  it('drops a connection that never finishes sending its headers', async () => {
    server = await startExposed({ timeouts: { headersMs: 200, requestMs: 300, keepAliveMs: 200, checkIntervalMs: 50 } });
    const port = server.port;
    const closedAfter = await new Promise<number>((resolve, reject) => {
      const started = Date.now();
      const socket = connect(port, '127.0.0.1', () => socket.write('GET /up HTTP/1.1\r\nHost: relay\r\nX-Slow: '));
      socket.on('error', () => undefined);
      socket.resume();
      socket.on('close', () => resolve(Date.now() - started));
      setTimeout(() => reject(new Error('still open')), 3000);
    });
    expect(closedAfter).toBeLessThan(1500);
  });

  it('traces when a phone\'s challenge, upgrade and dial-back arrive, with its address and nothing secret', async () => {
    const lines: string[] = [];
    server = await startExposed({ trace: (line) => lines.push(line) });
    const base = `ws://127.0.0.1:${server.port}/${ACCOUNT}`;
    const { dials } = await controlSocket(base);
    const phone = { 'cf-connecting-ip': '203.0.113.21' };
    const res = await fetch(`http://127.0.0.1:${server.port}/${ACCOUNT}?role=challenge`, { headers: phone });
    const { nonce } = (await res.json()) as { nonce: string };
    const client = upgradeStatus(base, phone);
    await until(() => dials.length === 1);
    const { id } = JSON.parse(dials[0]!) as { id: string };
    await once(open(`${base}?role=dial`, agentHeaders('dial', id)), 'open');
    expect(await client.settled).toBe(101);
    expect(lines).toEqual([
      'relay challenge from 203.0.113.21',
      'relay client upgrade from 203.0.113.21',
      'relay dial upgrade',
    ]);
    for (const secret of [nonce, id, ACCOUNT]) expect(lines.join('\n')).not.toContain(secret);
  });

  it('keeps a client waiting for its dial past the request timeout', async () => {
    server = await startExposed({ timeouts: { headersMs: 200, requestMs: 300, keepAliveMs: 200, checkIntervalMs: 50 } });
    const base = `ws://127.0.0.1:${server.port}/${ACCOUNT}`;
    const { dials } = await controlSocket(base);
    const phone = upgradeStatus(base);
    await until(() => dials.length === 1);
    await new Promise((r) => setTimeout(r, 600));
    const { id } = JSON.parse(dials[0]!) as { id: string };
    await once(open(`${base}?role=dial`, agentHeaders('dial', id)), 'open');
    expect(await phone.settled).toBe(101);
  });

  it('negotiates no compression, so a small frame cannot inflate past the frame limit', async () => {
    server = await startExposed();
    const socket = open(`ws://127.0.0.1:${server.port}/${ACCOUNT}?role=agent`, agentHeaders('agent'));
    await once(socket, 'open');
    expect(socket.extensions).toBe('');
  });

  it('stays up and answers 401 to a malformed agent authorization', async () => {
    server = await startExposed();
    const base = `ws://127.0.0.1:${server.port}/${ACCOUNT}`;
    for (const authorization of ['Perch-Agent 1.' + 'A'.repeat(86), 'Perch-Agent 999999999999.' + '_'.repeat(86), 'ÿ'.repeat(200)]) {
      expect(await upgradeStatus(`${base}?role=agent`, { authorization }).settled).toBe(401);
    }
    expect((await fetch(`http://127.0.0.1:${server.port}/up`)).status).toBe(200);
  });

  it('logs a refusal with its address, and never a nonce, a signature or a frame', async () => {
    const lines: string[] = [];
    server = await startExposed({ connections: { maxConnections: 50, maxPerAddress: 1 }, log: (line) => lines.push(line) });
    const base = `ws://127.0.0.1:${server.port}/${ACCOUNT}`;
    const { dials } = await controlSocket(base);
    const nonce = ((await (await fetch(`http://127.0.0.1:${server.port}/${ACCOUNT}?role=challenge`)).json()) as { nonce: string }).nonce;
    const sig = 'S'.repeat(86);
    const device = 'D'.repeat(43);
    const query = `?device=${device}&nonce=${nonce}&sig=${sig}`;
    expect(await refusalCode(`${base}${query}`, { 'cf-connecting-ip': '203.0.113.9' })).toBe(4401);
    upgradeStatus(base, { 'cf-connecting-ip': '203.0.113.9' });
    await until(() => dials.length === 1);
    expect(await upgradeStatus(`${base}${query}`, { 'cf-connecting-ip': '203.0.113.9' }).settled).toBe(429);
    expect(lines.some((line) => line.includes('429') && line.includes('203.0.113.9'))).toBe(true);
    for (const secret of [nonce, sig, device]) expect(lines.join('\n')).not.toContain(secret);
  });
});
