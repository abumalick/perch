import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { IN_BAND_REFUSAL, MAX_FRAME_BYTES, REFUSAL } from '@tarfa/secure-channel';
import { clientAddress, type PhoneAdmission } from '../application/phone-admission';
import { limitedDevices, type DiskReadLimiter } from '../application/disk-read-limiter';
import type { AgentDeviceGate } from '../server/device-gate-wiring';
import type { WsServer } from '../server/ws-server';
import { wsFrameSocket } from './ws-frame-socket';

const LOOPBACK = '127.0.0.1';
export const HEARTBEAT_MS = 30_000;
export const HEADERS_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const TOO_MANY = IN_BAND_REFUSAL + 429;

export interface PhoneListenerOptions {
  // 0 picks a free port (tests).
  port: number;
  gate: AgentDeviceGate;
  server: Pick<WsServer, 'acceptPhoneSocket'>;
  admission: PhoneAdmission;
  limiter: DiskReadLimiter;
  log: (message: string) => void;
  heartbeatMs?: number;
  // The connection's auth deadline timer (tests shorten it).
  startTimer?: (fn: () => void, ms: number) => () => void;
}

export interface PhoneListener {
  port: number;
  close(): Promise<void>;
}

// The port phones reach the agent on, through whatever publishes it (tailscale serve, Funnel, a
// reverse proxy). It takes a WebSocket upgrade on any path, since `tailscale serve --set-path`
// strips its prefix before proxying, and answers anything else 404: the hooks routes live on
// the hooks port only. Every socket runs the Noise session.
// A refused socket is upgraded and closed in band (4429), since a browser reports any refused
// upgrade as 1006.
export function startPhoneListener(opts: PhoneListenerOptions): Promise<PhoneListener> {
  const { gate, server, admission, limiter } = opts;
  const devices = limitedDevices(gate.devices, limiter, () => gate.roster());
  const alive = new WeakMap<WebSocket, boolean>();
  const http = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  http.headersTimeout = HEADERS_TIMEOUT_MS;
  http.requestTimeout = REQUEST_TIMEOUT_MS;
  http.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });

  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => undefined);
    const forwarded = req.headers['x-forwarded-for'];
    const address = clientAddress(req.socket.remoteAddress ?? '', Array.isArray(forwarded) ? forwarded.join(',') : forwarded);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => undefined);
      const frame = wsFrameSocket(ws, true);
      const slot = admission.admit(address, () => frame.close(TOO_MANY, REFUSAL.tooManyPending));
      if (!slot.ok) {
        gate.options({}).refusalLog?.line(`phone:${slot.reason}`, `phone port: refused a socket from ${address ?? 'a local proxy'}: too many (${slot.reason})`);
        frame.close(TOO_MANY, REFUSAL.tooManyConnections);
        return;
      }
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      frame.onClose(slot.release);
      server.acceptPhoneSocket(frame, gate.staticPrivate, {
        ...gate.options({ onAuthenticated: slot.authenticated }),
        devices,
        ...(opts.startTimer ? { startTimer: opts.startTimer } : {}),
      });
    });
  });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, LOOPBACK, () => {
      http.off('error', reject);
      http.on('error', (err) => opts.log(`phone port: ${err.message}`));
      const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
          if (!alive.get(ws)) {
            ws.terminate();
            continue;
          }
          alive.set(ws, false);
          ws.ping();
        }
      }, opts.heartbeatMs ?? HEARTBEAT_MS);
      heartbeat.unref();
      const address = http.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : opts.port,
        close: async () => {
          clearInterval(heartbeat);
          for (const ws of wss.clients) ws.terminate();
          wss.close();
          await new Promise<void>((done) => http.close(() => done()));
        },
      });
    });
  });
}
