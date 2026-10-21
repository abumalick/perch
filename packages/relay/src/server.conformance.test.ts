import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { accountId, generateAgentKeys, generateJoinKey } from '@perch/secure-channel';
import { SocketChannel, relayConformance, type ConformanceHost } from './conformance.ts';
import { startRelayServer, type RelayServer } from './server.ts';

const keys = generateAgentKeys();
const account = accountId(keys.ed25519.publicKey);
const limits = { dialTimeoutMs: 2000, maxPending: 2, maxPairs: 3, maxEnrolments: 8 };
const joinKey = generateJoinKey();
const adminKey = generateJoinKey();
const joinMax = 5;

let server: RelayServer;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  server = await startRelayServer({
    port: 0,
    host: '127.0.0.1',
    limits,
    joinKey,
    adminKey,
    joinLimit: { max: joinMax, windowMs: 60_000 },
    clientIpHeader: 'cf-connecting-ip',
  });
});

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.terminate());
  await server.close();
});

function upgrade(path: string, headers?: Record<string, string>): Promise<{ status: number; socket?: SocketChannel }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, { headers });
    sockets.push(ws);
    const channel = new SocketChannel(
      (data) => ws.send(data, { binary: typeof data !== 'string' }),
      (code, reason) => ws.close(code, reason),
    );
    ws.on('message', (data: Buffer, binary) => channel.push(binary ? new Uint8Array(data) : data.toString()));
    ws.on('close', (code, reason) => channel.end(code, reason.toString()));
    ws.on('error', () => undefined);
    ws.once('open', () => resolve({ status: 101, socket: channel }));
    ws.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      ws.terminate();
    });
  });
}

const host: ConformanceHost = {
  account,
  agentPrivateKey: keys.ed25519.privateKey,
  agentPublicKey: keys.ed25519.publicKey,
  limits,
  joinKey,
  joinMax,
  adminKey,
  fetch: async (method, path, headers) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers });
    return { status: res.status, body: await res.text() };
  },
  request: async (path, headers) => (await fetch(`http://127.0.0.1:${server.port}${path}`, { headers })).status,
  get: async (path) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
    return { status: res.status, body: await res.text(), headers: Object.fromEntries(res.headers) };
  },
  upgrade,
};

relayConformance('Node server', { describe, it, beforeEach, afterEach, expect }, () => host);
