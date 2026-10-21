import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SocketChannel, relayConformance, type ConformanceHost } from '@perch/relay/conformance';

const BASE = 'https://relay.test';

async function upgrade(path: string, headers: Record<string, string> = {}): Promise<{ status: number; socket?: SocketChannel }> {
  const res = await SELF.fetch(`${BASE}${path}`, { headers: { ...headers, upgrade: 'websocket' } });
  const ws = res.webSocket;
  if (res.status !== 101 || !ws) {
    await res.body?.cancel();
    return { status: res.status };
  }
  const channel = new SocketChannel(
    (data) => ws.send(data),
    (code, reason) => ws.close(code, reason),
  );
  // Binary frames arrive as Blobs, read asynchronously: chain every event so frames and the
  // close reach the channel in the order they arrived.
  let delivered = Promise.resolve();
  ws.addEventListener('message', (e) => {
    const data = e.data as string | ArrayBuffer | Blob;
    delivered = delivered.then(async () => {
      if (typeof data === 'string') channel.push(data);
      else channel.push(new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data));
    });
  });
  ws.addEventListener('close', (e) => {
    delivered = delivered.then(() => channel.end(e.code, e.reason));
  });
  ws.accept();
  return { status: 101, socket: channel };
}

const host: ConformanceHost = {
  account: env.TEST_ACCOUNT,
  agentPrivateKey: env.TEST_AGENT_KEY,
  agentPublicKey: env.TEST_AGENT_PUBLIC_KEY,
  limits: {
    dialTimeoutMs: Number(env.RELAY_DIAL_TIMEOUT_MS),
    maxPending: Number(env.RELAY_MAX_PENDING),
    maxPairs: Number(env.RELAY_MAX_PAIRS),
    maxEnrolments: Number(env.RELAY_MAX_ENROLMENTS),
  },
  joinKey: env.JOIN_KEY!,
  joinMax: Number(env.RELAY_JOIN_MAX),
  adminKey: env.ADMIN_KEY!,
  fetch: async (method, path, headers) => {
    const res = await SELF.fetch(`${BASE}${path}`, { method, headers });
    return { status: res.status, body: await res.text() };
  },
  request: async (path, headers) => {
    const res = await SELF.fetch(`${BASE}${path}`, { headers });
    await res.body?.cancel();
    return res.status;
  },
  get: async (path) => {
    const res = await SELF.fetch(`${BASE}${path}`);
    return { status: res.status, body: await res.text(), headers: Object.fromEntries(res.headers) };
  },
  upgrade,
};

relayConformance('Cloudflare Worker', { describe, it, beforeEach, afterEach, expect }, () => host);
