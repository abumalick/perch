import { DurableObject } from 'cloudflare:workers';
import { CHALLENGE_HEADERS, Relay, parseRelayRequest, type PendingUpgrade, type RelayData, type RelayStore } from '@perch/relay';
import { parseRelayLimits } from '@perch/relay/config';
import { REFUSAL, startTimer } from '@perch/secure-channel';
import { DoDirectory } from './do-directory';
import { refusedInBand } from './in-band';
import type { Env } from './env';

// One account's relay: the agent's control socket and every client/dial-back pair. The Worker
// has already authenticated the request before it reaches here.
export class RelayRoom extends DurableObject<Env> {
  private readonly directory: DoDirectory;
  private readonly relay: Relay;
  // Audit only: the first socket event after the object starts. With sockets already open at
  // that point, the object has just woken from hibernation.
  private started = true;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the object: the agent's control heartbeat.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.directory = new DoDirectory(ctx);

    // The object's SQLite-backed KV: the policy and the challenge key survive hibernation. The
    // nonces already used are in the core's memory, so a woken object has forgotten them; each
    // expires within the challenge TTL anyway.
    const store: RelayStore = {
      get: (key) => ctx.storage.kv.get<string>(key),
      put: (key, value) => ctx.storage.kv.put(key, value),
      delete: (key) => void ctx.storage.kv.delete(key),
    };
    this.relay = new Relay({
      directory: this.directory,
      store,
      newId: () => crypto.randomUUID(),
      startTimer,
      ...parseRelayLimits({
        dialTimeoutMs: env.RELAY_DIAL_TIMEOUT_MS,
        maxPending: env.RELAY_MAX_PENDING,
        maxPairs: env.RELAY_MAX_PAIRS,
        maxEnrolments: env.RELAY_MAX_ENROLMENTS,
      }),
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parsed = parseRelayRequest(url.pathname + url.search, (name) => request.headers.get(name));
    if (!parsed) return new Response('unknown route', { status: 404 });
    // An upgraded one goes to the core, which refuses it as the Node server does.
    if (parsed.role === 'challenge' && request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      const nonce = this.relay.challenge(parsed.account);
      if (nonce === null) return new Response(REFUSAL.unknownAccount, { status: 404, headers: { 'content-type': 'text/plain' } });
      return new Response(JSON.stringify({ nonce }), { headers: CHALLENGE_HEADERS });
    }
    // A client's request stays open until its agent dials back (or the dial times out); other
    // requests to this object are still delivered meanwhile, and one of them resolves it.
    return new Promise<Response>((resolve) => {
      let settled = false;
      const settle = (response: Response) => {
        if (settled) return false;
        settled = true;
        resolve(response);
        return true;
      };
      const upgrade: PendingUpgrade = {
        accept: (label) => {
          if (settled || request.signal.aborted) return null;
          const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
          const peer = this.directory.accept(server, label);
          settle(new Response(null, { status: 101, webSocket: client }));
          return peer;
        },
        reject: (status, reason) => {
          settle(new Response(reason, { status }));
        },
        // Not filed with the object: the socket is closed before anything could reach it.
        refuse: (code, reason) => {
          if (settled || request.signal.aborted) return;
          settle(refusedInBand(code, reason));
        },
        onAbort: (listener) => request.signal.addEventListener('abort', listener),
      };
      this.relay.handle(parsed, upgrade);
    });
  }

  // The account was removed from the registry: close what it holds and forget its state. The
  // core marks it removed, so this comes after the wipe.
  async evict(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.relay.evict();
  }

  // The account joined again.
  async reinstate(): Promise<void> {
    this.relay.reinstate();
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const peer = this.directory.peerOf(socket);
    if (this.env.RELAY_AUDIT === '1') {
      if (this.started) console.log(JSON.stringify({ audit: 'room-start', openSockets: this.ctx.getWebSockets().length }));
      audit(this.directory.labelOf(peer)?.kind, message);
    }
    this.started = false;
    this.relay.message(peer, message as RelayData, typeof message !== 'string');
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    this.relay.closed(this.directory.peerOf(socket), code, reason);
  }

  override webSocketError(socket: WebSocket): void {
    this.relay.closed(this.directory.peerOf(socket), 1006, '');
  }
}

// Verification aid, off unless RELAY_AUDIT=1: shows what the relay could read of each frame,
// which should be nothing. Logs the frame's size, whether it parses as JSON, and its first 24
// bytes in hex (a flag byte then ciphertext), so a plaintext leak would be visible in the tail.
function audit(kind: string | undefined, message: string | ArrayBuffer): void {
  if (kind !== 'client' && kind !== 'agent') return;
  const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message);
  const text = new TextDecoder().decode(bytes);
  let looksLikeJson = false;
  try {
    JSON.parse(text);
    looksLikeJson = true;
  } catch {
    // Expected for ciphertext.
  }
  const head = Array.from(bytes.subarray(0, 24), (b) => b.toString(16).padStart(2, '0')).join('');
  console.log(
    JSON.stringify({ audit: 'frame', from: kind, bytes: bytes.length, binary: typeof message !== 'string', looksLikeJson, head }),
  );
}
