import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { JOIN_HEADER, accountId, generateAgentKeys, signAgentAuth, signJoinAuth } from '@perch/secure-channel';
import { RelayRoom } from '../src/relay-room';

// The registry is changed before the account's RelayRoom is asked to close what it holds. A
// failed eviction RPC leaves the account denied but its sockets open; a second removal must
// evict again rather than answer 404 for the no longer registered account.
describe('account removal whose eviction failed', () => {
  it('evicts on the next removal, closing the established pair', async () => {
    const keys = generateAgentKeys();
    const account = accountId(keys.ed25519.publicKey);
    const now = Date.now();
    const sockets: WebSocket[] = [];
    const nextMessage = (socket: WebSocket) => new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('message timed out')), 2_000);
      socket.addEventListener('message', (event) => {
        clearTimeout(timeout);
        const data = event.data as string | ArrayBuffer | Blob;
        if (typeof data === 'string') resolve(data);
        else if (data instanceof Blob) void data.arrayBuffer().then((buffer) => resolve(new TextDecoder().decode(buffer)), reject);
        else resolve(new TextDecoder().decode(data));
      }, { once: true });
    });
    const upgrade = async (path: string, headers: Record<string, string> = {}) => {
      const response = await SELF.fetch(`https://relay.test/${account}${path}`, { headers: { upgrade: 'websocket', ...headers } });
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      socket.accept();
      sockets.push(socket);
      return socket;
    };
    const joined = await SELF.fetch(`https://relay.test/${account}?role=join&key=${keys.ed25519.publicKey}`, {
      method: 'POST',
      headers: {
        authorization: signAgentAuth(keys.ed25519.privateKey, { account, role: 'join' }, now),
        [JOIN_HEADER]: signJoinAuth(env.JOIN_KEY!, { account, role: 'join' }, now),
        'cf-connecting-ip': '203.0.113.200',
      },
    });
    expect(joined.status).toBe(201);
    await joined.body?.cancel();
    try {
      await upgrade('?role=agent', { authorization: signAgentAuth(keys.ed25519.privateKey, { account, role: 'agent' }, now) });
      const spare = await upgrade('?role=spare', {
        authorization: signAgentAuth(keys.ed25519.privateKey, { account, role: 'spare', dialId: 'audit-spare' }, now),
        'x-perch-dial': 'audit-spare',
      });
      const paired = nextMessage(spare);
      const client = await upgrade('');
      expect(await paired).toBe('paired');
      const eviction = vi.spyOn(RelayRoom.prototype, 'evict').mockRejectedValueOnce(new Error('injected Durable Object RPC failure'));
      const remove = () => SELF.fetch(`https://relay.test/${account}?role=remove`, {
        method: 'POST',
        headers: {
          [JOIN_HEADER]: signJoinAuth(env.ADMIN_KEY!, { account, role: 'remove' }, Date.now()),
          'cf-connecting-ip': '203.0.113.200',
        },
      });
      const first = await remove();
      expect(first.status).toBe(500);
      await first.body?.cancel();
      expect(await env.REGISTRY.getByName('registry').lookup(account)).toBeUndefined();
      const spareClosed = new Promise<number>((resolve) => spare.addEventListener('close', (event) => resolve(event.code), { once: true }));
      const clientClosed = new Promise<number>((resolve) => client.addEventListener('close', (event) => resolve(event.code), { once: true }));
      const retry = await remove();
      expect(retry.status).toBe(200);
      await retry.body?.cancel();
      expect(eviction).toHaveBeenCalledTimes(2);
      expect(await spareClosed).toBe(4004);
      expect(await clientClosed).toBe(4004);
      expect((await remove()).status).toBe(200);
    } finally {
      vi.restoreAllMocks();
      sockets.forEach((socket) => socket.close());
    }
  });
});
