import { IN_BAND_REFUSAL, REFUSAL } from '@perch/secure-channel';
import { parseRelayRequest } from '@perch/relay';
import { refusedInBand } from './in-band';
import { addressKey } from '@perch/relay/address-key';
import { parseAdminRequest } from '@perch/relay/registry';
import { AccountCache, authorizeCached } from './account-cache';
import type { Env } from './env';

export { RelayRoom } from './relay-room';
export { RegistryRoom } from './registry-room';

// Registered keys and misses, per isolate (see account-cache.ts), so the phone's requests and a
// repeated guess do not each reach the single registry object.
const accounts = new AccountCache({ now: Date.now, hitMs: 60_000, missMs: 10_000, maxEntries: 4096 });

function registry(env: Env) {
  return env.REGISTRY.getByName('registry');
}

function isUpgrade(request: Request): boolean {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

function refuse(status: number, reason: string): Response {
  return new Response(reason, { status, headers: { 'content-type': 'text/plain' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/up') return new Response('OK');
    const header = (name: string) => request.headers.get(name);
    const admin = parseAdminRequest(url.pathname + url.search, request.method, header);
    if (admin) {
      try {
        const { status, body } = await registry(env).admin(admin, addressKey(header('cf-connecting-ip') ?? '') ?? 'unknown');
        // Other isolates keep theirs until it expires; the evicted RelayRoom refuses whatever a
        // stale hit lets through, and the control socket is confirmed with the registry anyway.
        if (admin.role === 'remove') accounts.removed(admin.account);
        if (admin.role === 'join' && status < 300) accounts.joined(admin.account);
        const type = admin.role === 'machines' && status === 200 ? 'application/json' : 'text/plain';
        return new Response(body, { status, headers: { 'content-type': type, 'cache-control': 'no-store' } });
      } catch {
        return refuse(500, 'relay misconfigured');
      }
    }
    const parsed = parseRelayRequest(url.pathname + url.search, header);
    if (!parsed) return refuse(404, 'unknown route');
    let refused: 404 | 401 | null;
    try {
      // Before any Durable Object exists for the account: a stranger's guess allocates nothing, and
      // a repeated one is answered from this isolate's memory.
      refused = await authorizeCached(parsed, accounts, (account) => registry(env).lookup(account), Date.now());
    } catch {
      return refuse(500, 'relay misconfigured');
    }
    if (refused === 404 && parsed.role === 'client' && isUpgrade(request)) return refusedInBand(IN_BAND_REFUSAL + 404, REFUSAL.unknownAccount);
    if (refused) return refuse(refused, refused === 404 ? REFUSAL.unknownAccount : 'agent authentication failed');
    // The challenge is signed with the account's key, kept in its Durable Object.
    if (parsed.role === 'challenge') return env.RELAY.getByName(parsed.account).fetch(request);
    if (!isUpgrade(request)) return refuse(426, 'websocket required');
    return env.RELAY.getByName(parsed.account).fetch(request);
  },
} satisfies ExportedHandler<Env>;
