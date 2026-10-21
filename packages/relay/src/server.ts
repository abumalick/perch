import { createServer, STATUS_CODES, type IncomingHttpHeaders, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { IN_BAND_REFUSAL, MAX_FRAME_BYTES, REFUSAL, startTimer } from '@perch/secure-channel';
import {
  CHALLENGE_HEADERS,
  MemoryDirectory,
  Relay,
  parseRelayRequest,
  type Peer,
  type PendingUpgrade,
} from './relay.ts';
import { authorize } from './authorize.ts';
import type { RelayLimits } from './config.ts';
import {
  DEFAULT_JOIN_LIMIT,
  JoinRateLimiter,
  MemoryRegistry,
  handleAdminRequest,
  parseAdminRequest,
  type AccountRegistry,
  type JoinLimit,
} from './registry.ts';
import { ConnectionLimiter, clientAddress, type ConnectionCaps, type ConnectionSlot } from './connection-limits.ts';
import { lineBudget } from './line-budget.ts';

export interface RelayServerOptions {
  port: number;
  host?: string;
  // The accounts served, each with its agent's Ed25519 public key. Unset, an empty one held in
  // memory, which only joins fill.
  registry?: AccountRegistry;
  // The secret `perch connect` proves to register a machine; unset, joining is off (501).
  joinKey?: string;
  // The operator's key to list and remove accounts; unset, those answer 501.
  adminKey?: string;
  joinLimit?: JoinLimit;
  limits?: RelayLimits;
  // Every socket is pinged on this interval and dropped if the previous ping went unanswered.
  // The control socket carries no traffic of its own, so without this a half-open one would
  // leave the agent believing it is reachable while no client can get through.
  heartbeatMs?: number;
  // Upgrades being answered plus open sockets, for the host and per client address.
  connections?: ConnectionCaps;
  // The header a proxy on this machine names the client in (`cf-connecting-ip`,
  // `x-forwarded-for`). Unset, no header is believed.
  clientIpHeader?: string;
  // Slowloris: how long a connection may take to send its headers and its whole request, and
  // how long an idle keep-alive connection stays open.
  timeouts?: HttpTimeouts;
  // One line per refusal worth seeing. Never a URL: its query carries nonces and signatures.
  log?: (line: string) => void;
  // One line as each step of a phone's connect arrives (challenge, upgrade, the agent's dial),
  // so a slow connect can be placed: whether the phone's request reached the relay, and when.
  // At most TRACE_PER_MINUTE lines a minute, so a flood of challenges cannot fill the journal.
  trace?: (line: string) => void;
}

export interface HttpTimeouts {
  headersMs: number;
  requestMs: number;
  keepAliveMs: number;
  // How often Node checks the two above; its 30 s default would let a slow request run long.
  checkIntervalMs: number;
}

export interface RelayServer {
  port: number;
  stats(): { accounts: number; connections: number };
  close(): Promise<void>;
}

const DEFAULT_HEARTBEAT_MS = 20_000;
// Below the core's per-account caps (8 pending, 16 pairs), so one address cannot fill an
// account's slots on its own; a household's phones need far fewer. The agent is exempt.
const DEFAULT_CONNECTIONS: ConnectionCaps = { maxConnections: 256, maxPerAddress: 6, agentReserve: 16 };
const DEFAULT_TIMEOUTS: HttpTimeouts = { headersMs: 10_000, requestMs: 15_000, keepAliveMs: 5_000, checkIntervalMs: 1_000 };
// A refusal is logged once a minute per status and address, so a flood cannot fill the journal.
const LOG_EVERY_MS = 60_000;
// A phone's connect writes three lines; a household's reconnects stay well within this.
const TRACE_PER_MINUTE = 30;
// How long a refused phone's socket may wait for the client to answer its close frame: past
// that it is cut, so a client that never answers cannot hold a slot until the heartbeat.
const REFUSAL_LINGER_MS = 1_000;

function wsPeer(socket: WebSocket): Peer {
  return {
    send: (data, binary) => socket.send(data, { binary }),
    close: (code, reason) => socket.close(code, reason),
  };
}

function headerOf(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

// The same checks ws applies before completing a handshake.
function isValidHandshake(method: string | undefined, headers: IncomingHttpHeaders): boolean {
  const key = headers['sec-websocket-key'];
  const version = headers['sec-websocket-version'];
  return (
    method === 'GET' &&
    headers.upgrade?.toLowerCase() === 'websocket' &&
    typeof key === 'string' &&
    /^[+/0-9A-Za-z]{22}==$/.test(key.trim()) &&
    (version === '8' || version === '13')
  );
}

export function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const registry = options.registry ?? new MemoryRegistry();
  const lookup = (account: string) => registry.lookup(account);
  const joinLimiter = new JoinRateLimiter(options.joinLimit ?? DEFAULT_JOIN_LIMIT);
  const accounts = new Map<string, { relay: Relay; directory: MemoryDirectory }>();
  const accountRelay = (account: string) => {
    let entry = accounts.get(account);
    if (!entry) {
      const directory = new MemoryDirectory();
      const relay = new Relay({
        directory,
        newId: () => randomUUID(),
        startTimer,
        ...options.limits,
      });
      entry = { relay, directory };
      accounts.set(account, entry);
    }
    return entry;
  };
  // ws would otherwise buffer up to 100 MiB of a message before the core could refuse it.
  // Compression is off: an inflated frame could otherwise grow past what maxPayload saw.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  const alive = new WeakMap<WebSocket, boolean>();
  const caps = options.connections ?? DEFAULT_CONNECTIONS;
  const limiter = new ConnectionLimiter(caps);
  const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  const trace = options.trace && lineBudget(options.trace, { max: TRACE_PER_MINUTE, windowMs: 60_000 });
  const lastLogged = new Map<string, number>();
  const logRefusal = (status: number, reason: string, address: string) => {
    if (!options.log) return;
    const now = Date.now();
    const key = `${status} ${address}`;
    if ((lastLogged.get(key) ?? -Infinity) > now - LOG_EVERY_MS) return;
    if (lastLogged.size > 1000) lastLogged.clear();
    lastLogged.set(key, now);
    options.log(`relay refused ${status} (${reason}) from ${address}`);
  };

  // Plain HTTP answers the way the Worker does: a health check, then the same refusals as an
  // upgrade, and 426 for a served account.
  const http: Server = createServer(
    {
      headersTimeout: timeouts.headersMs,
      requestTimeout: timeouts.requestMs,
      keepAliveTimeout: timeouts.keepAliveMs,
      connectionsCheckingInterval: timeouts.checkIntervalMs,
    },
    (req, res) => {
      const answer = (status: number) => {
        if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain' }).end(STATUS_CODES[status]);
      };
      if (req.url === '/up') return answer(200);
      const header = (name: string) => headerOf(req.headers, name);
      const admin = parseAdminRequest(req.url ?? '', req.method ?? 'GET', header);
      if (admin) {
        const ipHeader = options.clientIpHeader;
        const address = clientAddress(req.socket.remoteAddress, ipHeader ? header(ipHeader) : undefined);
        // A loopback proxy that names no client stands for all of them: they share one budget.
        handleAdminRequest(admin, address.counted ?? 'local', {
          registry,
          joinKey: options.joinKey,
          adminKey: options.adminKey,
          limiter: joinLimiter,
          now: Date.now,
          evict: (account) => {
            accounts.get(account)?.relay.evict();
            accounts.delete(account);
          },
        })
          .then(({ status, body }) => {
            if (status >= 400) logRefusal(status, body, address.label);
            const type = admin.role === 'machines' && status === 200 ? 'application/json' : 'text/plain';
            res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
          })
          .catch(() => answer(500));
        return;
      }
      const request = parseRelayRequest(req.url ?? '', header);
      if (!request) return answer(404);
      if (request.role === 'challenge' && trace) {
        const ipHeader = options.clientIpHeader;
        trace(`relay challenge from ${clientAddress(req.socket.remoteAddress, ipHeader ? header(ipHeader) : undefined).label}`);
      }
      authorize(request, lookup, Date.now())
        .then((refused) => {
          if (refused || request.role !== 'challenge') return answer(refused ?? 426);
          const nonce = accountRelay(request.account).relay.challenge(request.account);
          if (nonce === null) return answer(404);
          res.writeHead(200, CHALLENGE_HEADERS).end(JSON.stringify({ nonce }));
        })
        .catch(() => answer(500));
    },
  );
  // Node drops a connection past this at once, before reading anything from it.
  http.maxConnections = caps.maxSockets ?? caps.maxConnections * 2;
  // A request Node cannot parse gets a bare status line: nothing about the server or the error.
  http.on('clientError', (_err, socket: Socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n', () => socket.destroy());
    else socket.destroy();
  });

  http.on('upgrade', (req, socket: Socket, head: Buffer) => {
    socket.on('error', () => undefined);
    const header = options.clientIpHeader;
    const address = clientAddress(req.socket.remoteAddress, header ? headerOf(req.headers, header) : undefined);
    const request = parseRelayRequest(req.url ?? '', (name) => headerOf(req.headers, name));
    // The agent's sockets share the home address with a phone on the home network, so they count
    // against the host only; a forged signature is refused at once below.
    const agentRole = request?.role === 'agent' || request?.role === 'dial';
    const slot: ConnectionSlot | null = agentRole ? limiter.acquireAgent() : limiter.acquire(address.counted);
    const refuseRaw = (status: number, reason: string) => {
      logRefusal(status, reason, address.label);
      slot?.release();
      // Destroyed once written: a client that never closes its side must not keep the slot.
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${reason}`, () =>
        socket.destroy(),
      );
    };
    if (!slot) {
      refuseRaw(429, 'too many connections');
      return;
    }
    socket.once('close', () => slot.release());
    // Node keeps an upgrade's socket half-open, so a client that gives up while waiting for its
    // dial would otherwise hold its slot, and the core's pending one, until the dial timeout.
    const leftEarly = () => socket.destroy();
    socket.once('end', leftEarly);
    if (!request) {
      refuseRaw(404, 'unknown route');
      return;
    }
    if (request.role === 'client') trace?.(`relay client upgrade from ${address.label}`);
    else if (request.role === 'dial') trace?.('relay dial upgrade');
    // Filled in once the account is authorized: a guessed account allocates nothing.
    let entry: { relay: Relay; directory: MemoryDirectory } | undefined;
    const upgrade: PendingUpgrade = {
      accept: (label) => {
        if (socket.destroyed) return null;
        socket.off('end', leftEarly);
        let accepted: WebSocket | null = null;
        // ws completes the handshake synchronously when no verifyClient hook is set.
        wss.handleUpgrade(req, socket, head, (ws) => {
          accepted = ws;
        });
        if (!accepted) return null;
        const ws: WebSocket = accepted;
        alive.set(ws, true);
        ws.on('pong', () => alive.set(ws, true));
        const peer = wsPeer(ws);
        const { relay, directory } = entry!;
        directory.add(peer, label, () => ws.readyState === WebSocket.OPEN);
        // ws refuses an oversized frame itself and closes only the sender; the partner must get
        // the same 1009 the core sends for a frame it refuses.
        ws.on('error', (err: Error & { code?: string }) => {
          if (err.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') relay.closed(peer, 1009, 'frame too large');
        });
        ws.on('message', (data: Buffer, binary) => relay.message(peer, binary ? data : data.toString(), binary));
        ws.on('close', (code, reason) => {
          relay.closed(peer, code, reason.toString());
          directory.remove(peer);
        });
        return peer;
      },
      reject: (status, reason) => {
        if (!socket.destroyed) refuseRaw(status, reason);
      },
      refuse: (code, reason) => {
        if (socket.destroyed) return;
        logRefusal(code - IN_BAND_REFUSAL, reason, address.label);
        socket.off('end', leftEarly);
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on('error', () => undefined);
          ws.close(code, reason);
          setTimeout(() => ws.terminate(), REFUSAL_LINGER_MS).unref();
        });
      },
      // The socket can close while the core awaits a signature check; its close has then fired.
      onAbort: (listener) => (socket.destroyed ? listener() : socket.once('close', listener)),
    };
    // The client's handshake is only completed once its agent has dialed, so check it here:
    // a request ws would refuse must not make the agent open a socket first.
    if (!isValidHandshake(req.method, req.headers)) {
      upgrade.reject(400, 'invalid websocket handshake');
      return;
    }
    // A phone's refusals are made in band (see relay.ts); the agent's roles keep the HTTP status.
    const deny = request.role === 'client' ? (status: number, reason: string) => upgrade.refuse(IN_BAND_REFUSAL + status, reason) : upgrade.reject;
    authorize(request, lookup, Date.now())
      .then(async (refused) => {
        if (refused) return deny(refused, refused === 404 ? REFUSAL.unknownAccount : 'agent authentication failed');
        // The signature check is asynchronous: the account may have been removed meanwhile.
        if (!(await lookup(request.account))) return deny(404, REFUSAL.unknownAccount);
        if (socket.destroyed) return;
        entry = accountRelay(request.account);
        entry.relay.handle(request, upgrade);
      })
      .catch(() => deny(500, REFUSAL.internal));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host, () => {
      http.off('error', reject);
      // An accept failure (out of file descriptors) must not bring the relay down.
      http.on('error', (err: Error & { code?: string }) => options.log?.(`relay server error: ${err.code ?? err.name}`));
      resolve({
        port: (http.address() as AddressInfo).port,
        stats: () => ({ accounts: accounts.size, connections: limiter.size }),
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.terminate();
            http.closeAllConnections();
            http.close(() => done());
          }),
      });
    });
  });
}
