// The relay contract, as one test suite every host runs: the Node server over real sockets and
// the Cloudflare Worker under the Workers pool. A host adapts its transport to `ConformanceHost`;
// the suite knows nothing of either.
//
// The test API is passed in rather than imported: the hosts run different vitest versions, and
// a `describe` resolved from this package would not register with the other host's runner.
// For the same reason this file imports nothing Node-only.
import {
  GATE_PARAM,
  GATE_READY,
  JOIN_HEADER,
  MAX_FRAME_BYTES,
  accountId,
  ed25519Signer,
  enrolKey,
  enrolProof,
  encodeGateReply,
  generateAgentKeys,
  generateDeviceKeys,
  signAgentAuth,
  signDeviceAuth,
  signJoinAuth,
  parseGateChallenge,
  REFUSAL,
  type RelayPolicy,
} from '@perch/secure-channel';
import { ACCOUNT_REMOVED, DIAL_HEADER } from './relay.ts';

export type Frame = string | Uint8Array;

// One open socket, as the suite sees it. A host feeds it every frame and the close from the
// moment the socket opens, so nothing is lost before a test starts reading.
export class SocketChannel {
  private readonly queue: Frame[] = [];
  private waiter: ((frame: Frame) => void) | null = null;
  private closeCode: number | null = null;
  private closeReason = '';
  private readonly closedListeners: Array<(code: number) => void> = [];

  constructor(
    readonly send: (data: Frame) => void,
    readonly close: (code?: number, reason?: string) => void,
  ) {}

  push(frame: Frame): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(frame);
    } else {
      this.queue.push(frame);
    }
  }

  end(code: number, reason = ''): void {
    if (this.closeCode !== null) return;
    this.closeCode = code;
    this.closeReason = reason;
    this.closedListeners.forEach((listener) => listener(code));
  }

  get isClosed(): boolean {
    return this.closeCode !== null;
  }

  next(timeoutMs = 3000): Promise<Frame> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('no frame arrived'));
      }, timeoutMs);
      this.waiter = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
    });
  }

  // Whether nothing arrived ahead of the answer to a heartbeat sent now. The relay handles a
  // socket's messages in order, so whatever it sent before reading the ping is queued ahead of
  // the pong: a frame that did not arrive, asserted without waiting on a clock.
  async quiet(): Promise<boolean> {
    this.send('ping');
    return (await this.next()) === 'pong';
  }

  // The close, with its reason.
  async closedWith(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    const code = await this.closed(timeoutMs);
    return { code, reason: this.closeReason };
  }

  closed(timeoutMs = 3000): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
      this.closedListeners.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }
}

export interface ConformanceHost {
  // An account the suite registers with `role=join` before each test, as `perch connect` does.
  account: string;
  // The agent's Ed25519 private key for `account` (base64url).
  agentPrivateKey: string;
  // Its public key, which the join carries.
  agentPublicKey: string;
  // The limits the host was started with; small ones keep the suite fast.
  limits: { dialTimeoutMs: number; maxPending: number; maxPairs: number; maxEnrolments: number };
  // The join key the host was started with, and how many join-key requests one client address
  // may make per window (a window longer than the suite). The host believes the client address
  // in `cf-connecting-ip`.
  joinKey: string;
  joinMax: number;
  // The operator's key to list and remove machines.
  adminKey: string;
  // Any HTTP request: its status and body.
  fetch(method: 'GET' | 'POST', path: string, headers?: Record<string, string>): Promise<{ status: number; body: string }>;
  // A plain HTTP GET: its status.
  request(path: string, headers?: Record<string, string>): Promise<number>;
  // A plain HTTP GET: its status, body and response headers (lower-case names).
  get(path: string): Promise<{ status: number; body: string; headers: Record<string, string> }>;
  // A WebSocket upgrade: 101 with the open socket, or the status it was refused with.
  upgrade(path: string, headers?: Record<string, string>): Promise<{ status: number; socket?: SocketChannel }>;
}

interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
}

export interface TestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void>, timeoutMs?: number): void;
  beforeEach(fn: () => void | Promise<void>): void;
  afterEach(fn: () => Promise<void>): void;
  expect(actual: unknown): Matchers;
}

const SUPERSEDED = 4000;
const MESSAGE_TOO_BIG = 1009;
const TOKEN = 'the-bearer-token';

function newDevice() {
  const { ed25519 } = generateDeviceKeys();
  return { key: ed25519.publicKey, sign: ed25519Signer(ed25519.privateKey) };
}
type Device = ReturnType<typeof newDevice>;

export function relayConformance(name: string, api: TestApi, getHost: () => ConformanceHost): void {
  const { describe, it, beforeEach, afterEach, expect } = api;

  describe(`relay conformance: ${name}`, () => {
    const opened: SocketChannel[] = [];
    let host: ConformanceHost;

    const signed = (
      role: 'agent' | 'dial' | 'spare',
      dialId?: string,
      options: { key?: string; now?: number; claimRole?: 'agent' | 'dial' | 'spare' } = {},
    ): Record<string, string> => {
      const claim = { account: host.account, role: options.claimRole ?? role, dialId };
      const headers: Record<string, string> = {
        authorization: signAgentAuth(options.key ?? host.agentPrivateKey, claim, options.now ?? Date.now()),
      };
      if (dialId !== undefined) headers[DIAL_HEADER] = dialId;
      return headers;
    };

    const upgrade = async (path: string, headers?: Record<string, string>) => {
      const result = await host.upgrade(path, headers);
      if (result.socket) opened.push(result.socket);
      return result;
    };

    const open = async (path: string, headers?: Record<string, string>): Promise<SocketChannel> => {
      const { status, socket } = await upgrade(path, headers);
      expect(status).toBe(101);
      return socket!;
    };

    // A phone is refused in band: the upgrade completes and the socket closes at once, with
    // 4000 + the HTTP status and the reason, which is all a browser can read of a refusal.
    const refusalOf = async (pending: Promise<{ status: number; socket?: SocketChannel }>) => {
      const { status, socket } = await pending;
      expect(status).toBe(101);
      return socket!.closedWith();
    };
    const refused = (path: string, headers?: Record<string, string>) => refusalOf(upgrade(path, headers));

    const clientPath = () => `/${host.account}`;
    const control = () => open(`/${host.account}?role=agent`, signed('agent'));

    // The client's upgrade stays open until the agent dials, so it is started, then the dial
    // is read off the control socket.
    const requestClient = async (ctl: SocketChannel) => {
      const pending = upgrade(clientPath());
      const { id } = JSON.parse(String(await ctl.next())) as { type: string; id: string };
      return { id, pending };
    };

    const pair = async (ctl: SocketChannel) => {
      const { id, pending } = await requestClient(ctl);
      const agent = await open(`/${host.account}?role=dial`, signed('dial', id));
      const { status, socket } = await pending;
      expect(status).toBe(101);
      return { client: socket!, agent };
    };

    const text = (frame: Frame) => (typeof frame === 'string' ? frame : `<binary ${frame.byteLength}>`);
    const bytes = (frame: Frame) => (typeof frame === 'string' ? `<text ${frame}>` : [...frame]);

    // Each test's join comes from its own address, outside the join tests' blocks, so it never
    // spends a join-rate budget a test counts on, even where the limiter outlives a test.
    let setups = 0;
    beforeEach(async () => {
      host = getHost();
      setups += 1;
      const claim = { account: host.account, role: 'join' as const };
      const now = Date.now();
      const { status } = await host.fetch('POST', `/${host.account}?role=join&key=${host.agentPublicKey}`, {
        'cf-connecting-ip': `192.0.2.${setups}`,
        authorization: signAgentAuth(host.agentPrivateKey, claim, now),
        [JOIN_HEADER]: signJoinAuth(host.joinKey, claim, now),
      });
      expect(status === 201 || status === 200 ? 'joined' : status).toBe('joined');
    });

    afterEach(async () => {
      // The host has processed a close once it answers it, so the next test's control socket
      // meets none of this one's. The Workers test pool never reports the answer to a close its
      // client started (production answers it: web_socket_auto_reply_to_close), hence the bound.
      await Promise.all(
        opened.splice(0).map(async (socket) => {
          if (!socket.isClosed) socket.close(1000, 'test over');
          await socket.closed(250).catch(() => undefined);
        }),
      );
    });

    it('answers the health check', async () => {
      expect(await host.request('/up')).toBe(200);
    });

    it('answers 404 for a route it does not serve', async () => {
      expect(await host.request('/a/b')).toBe(404);
      expect((await upgrade('/a/b')).status).toBe(404);
    });

    it('answers 404 for an unknown account, whatever the role, before anything else', async () => {
      expect(await host.request('/nobody')).toBe(404);
      expect(await refused('/nobody')).toEqual({ code: 4404, reason: REFUSAL.unknownAccount });
      expect((await upgrade('/nobody?role=agent', signed('agent'))).status).toBe(404);
    });

    it('refuses with a short reason, and says nothing about the host or its software', async () => {
      for (const path of ['/a/b', '/nobody', clientPath(), `/${host.account}?role=agent`]) {
        const { status, body, headers } = await host.get(path);
        expect(status >= 400).toBe(true);
        expect(/^[\w .,'-]{0,40}$/.test(body)).toBe(true);
        expect(headers['x-powered-by']).toBe(undefined);
        expect(headers['server'] === undefined || headers['server'] === 'cloudflare').toBe(true);
      }
    });

    it('answers 426 to a served account without a WebSocket upgrade', async () => {
      expect(await host.request(clientPath())).toBe(426);
    });

    it('refuses the agent roles without a valid signature', async () => {
      const stranger = generateAgentKeys().ed25519.privateKey;
      const agentPath = `/${host.account}?role=agent`;
      const dialPath = `/${host.account}?role=dial`;
      expect((await upgrade(agentPath)).status).toBe(401);
      expect((await upgrade(agentPath, signed('agent', undefined, { key: stranger }))).status).toBe(401);
      expect((await upgrade(agentPath, signed('agent', undefined, { now: Date.now() - 120_000 }))).status).toBe(401);
      expect((await upgrade(agentPath, signed('agent', undefined, { claimRole: 'dial' }))).status).toBe(401);
      expect((await upgrade(dialPath, { [DIAL_HEADER]: 'one' })).status).toBe(401);
      expect((await upgrade(dialPath, { ...signed('dial', 'one'), [DIAL_HEADER]: 'two' })).status).toBe(401);
      expect((await upgrade(dialPath, signed('dial', 'one', { key: stranger }))).status).toBe(401);
    });

    it('refuses a client with 4503 while no agent holds the account', async () => {
      expect(await refused(clientPath())).toEqual({ code: 4503, reason: REFUSAL.agentOffline });
    });

    it('pairs a client with a dialed socket and forwards frames both ways, text as text', async () => {
      const ctl = await control();
      const { client, agent } = await pair(ctl);
      client.send('{"type":"auth"}');
      expect(text(await agent.next())).toBe('{"type":"auth"}');
      client.send(Uint8Array.of(0, 1, 2, 255));
      expect(bytes(await agent.next())).toEqual([0, 1, 2, 255]);
      agent.send('from agent');
      expect(text(await client.next())).toBe('from agent');
      agent.send(Uint8Array.of(9, 8));
      expect(bytes(await client.next())).toEqual([9, 8]);
    });

    it('pairs a client with a spare the agent opened ahead, without a dial, telling the spare first', async () => {
      const ctl = await control();
      const spare = await open(`/${host.account}?role=spare`, signed('spare', 'spare-1'));
      expect(await spare.quiet()).toBe(true);
      const client = await open(clientPath());
      expect(text(await spare.next())).toBe('paired');
      client.send(Uint8Array.of(1, 2));
      expect(bytes(await spare.next())).toEqual([1, 2]);
      spare.send(Uint8Array.of(3));
      expect(bytes(await client.next())).toEqual([3]);
      expect(await ctl.quiet()).toBe(true);
      // The spare is spent: the next client is dialed for.
      expect((await requestClient(ctl)).id === 'spare-1').toBe(false);
    });

    it('closes an unpaired spare when a new control socket takes over', async () => {
      await control();
      const spare = await open(`/${host.account}?role=spare`, signed('spare', 'spare-1'));
      const ctl = await control();
      expect(await spare.closed()).toBe(1001);
      expect((await requestClient(ctl)).id === 'spare-1').toBe(false);
    });

    it('refuses a spare signed for another id or as a dial, and caps the unpaired spares', async () => {
      await control();
      expect((await upgrade(`/${host.account}?role=spare`, { ...signed('spare', 'spare-1'), [DIAL_HEADER]: 'spare-2' })).status).toBe(401);
      expect((await upgrade(`/${host.account}?role=spare`, signed('spare', 'spare-1', { claimRole: 'dial' }))).status).toBe(401);
      await open(`/${host.account}?role=spare`, signed('spare', 'spare-1'));
      expect((await upgrade(`/${host.account}?role=spare`, signed('spare', 'spare-1'))).status).toBe(409);
      await open(`/${host.account}?role=spare`, signed('spare', 'spare-2'));
      expect((await upgrade(`/${host.account}?role=spare`, signed('spare', 'spare-3'))).status).toBe(429);
    });

    it('answers a text ping with pong on every socket and never forwards it', async () => {
      const ctl = await control();
      ctl.send('ping');
      expect(text(await ctl.next())).toBe('pong');
      const { client, agent } = await pair(ctl);
      client.send('ping');
      expect(text(await client.next())).toBe('pong');
      client.send('after the ping');
      expect(text(await agent.next())).toBe('after the ping');
    });

    it('carries a close to the other side of the pair, with its code', async () => {
      const ctl = await control();
      const first = await pair(ctl);
      first.client.close(4100, 'client done');
      expect(await first.agent.closed()).toBe(4100);
      const second = await pair(ctl);
      second.agent.close(4101, 'agent done');
      expect(await second.client.closed()).toBe(4101);
    });

    // The agent refuses a device inside the session with 4003 and a REFUSAL; the phone reads it.
    it("carries the agent's close reason to the phone", async () => {
      const ctl = await control();
      const { client, agent } = await pair(ctl);
      agent.close(4003, REFUSAL.codeUsed);
      expect(await client.closedWith()).toEqual({ code: 4003, reason: REFUSAL.codeUsed });
    });

    it('fails a waiting client with 503 when the control socket closes', async () => {
      const ctl = await control();
      const { pending } = await requestClient(ctl);
      ctl.close(1000, 'agent stopping');
      expect(await refusalOf(pending)).toEqual({ code: 4503, reason: REFUSAL.agentOffline });
    });

    it('lets a new agent supersede the old one: 4000 for the old, its waiting clients fail, dials go to the new', async () => {
      const first = await control();
      const { pending } = await requestClient(first);
      const second = await control();
      expect(await first.closed()).toBe(SUPERSEDED);
      expect((await refusalOf(pending)).code).toBe(4503);
      const { client, agent } = await pair(second);
      client.send('through the new agent');
      expect(text(await agent.next())).toBe('through the new agent');
    });

    it('fails a client with 4504 when the agent does not dial in time, and refuses the late dial', async () => {
      const ctl = await control();
      const { id, pending } = await requestClient(ctl);
      expect(await refusalOf(pending)).toEqual({ code: 4504, reason: REFUSAL.agentSilent });
      expect((await upgrade(`/${host.account}?role=dial`, signed('dial', id))).status).toBe(404);
    });

    it('refuses a dial for a client it never announced', async () => {
      await control();
      expect((await upgrade(`/${host.account}?role=dial`, signed('dial', 'never-announced'))).status).toBe(404);
    });

    it('caps the clients waiting for a dial with 429', async () => {
      const ctl = await control();
      const waiting = [];
      for (let i = 0; i < host.limits.maxPending; i += 1) waiting.push((await requestClient(ctl)).pending);
      expect(await refused(clientPath())).toEqual({ code: 4429, reason: REFUSAL.tooManyPending });
      ctl.close(1000, 'done');
      for (const pending of waiting) expect((await refusalOf(pending)).code).toBe(4503);
    });

    it('caps the sockets of one account with 429, and frees a slot when a pair closes', async () => {
      const ctl = await control();
      const pairs = [];
      for (let i = 0; i < host.limits.maxPairs; i += 1) pairs.push(await pair(ctl));
      expect(await refused(clientPath())).toEqual({ code: 4429, reason: REFUSAL.tooManyConnections });
      expect(await ctl.quiet()).toBe(true);
      pairs[0]!.client.close(1000, 'done');
      await pairs[0]!.agent.closed();
      await pair(ctl);
    });

    it('forwards a frame of one Noise message and closes both sides on a larger one', async () => {
      const ctl = await control();
      const { client, agent } = await pair(ctl);
      client.send(new Uint8Array(MAX_FRAME_BYTES));
      const largest = await agent.next();
      expect(typeof largest === 'string' ? -1 : largest.byteLength).toBe(MAX_FRAME_BYTES);
      client.send(new Uint8Array(MAX_FRAME_BYTES + 1));
      expect(await client.closed()).toBe(MESSAGE_TOO_BIG);
      expect(await agent.closed()).toBe(MESSAGE_TOO_BIG);
    });

    it('closes both sides on a frame far over the limit, whichever side sends it', async () => {
      const ctl = await control();
      const { client, agent } = await pair(ctl);
      agent.send(new Uint8Array(256 * 1024));
      expect(await agent.closed()).toBe(MESSAGE_TOO_BIG);
      expect(await client.closed()).toBe(MESSAGE_TOO_BIG);
    });

    const challenge = async (): Promise<string> => {
      const { status, body } = await host.get(`/${host.account}?role=challenge`);
      expect(status).toBe(200);
      return (JSON.parse(body) as { nonce: string }).nonce;
    };

    const devicePath = async (
      device: Device,
      options: { nonce?: string; proof?: boolean; sig?: string; token?: string; cred?: string } = {},
    ): Promise<string> => {
      const nonce = options.nonce ?? (await challenge());
      const claim = { account: host.account, nonce, device: device.key };
      const query = new URLSearchParams({ device: device.key, nonce, sig: options.sig ?? (await signDeviceAuth(device.sign, claim)) });
      if (options.proof) query.set('proof', enrolProof(enrolKey(options.token ?? TOKEN, host.account), claim));
      if (options.cred) query.set('cred', options.cred);
      return `/${host.account}?${query}`;
    };

    // The relay acknowledges a policy, so a test knows it is in force before the next upgrade.
    const publish = async (ctl: SocketChannel, policy: Omit<RelayPolicy, 'type'> & { anonymous?: boolean }) => {
      ctl.send(JSON.stringify({ type: 'policy', ...policy }));
      expect(text(await ctl.next())).toBe('{"type":"applied"}');
    };

    const closedPolicy = (devices: Device[] = [], revoked: Device[] = []) => ({
      devices: devices.map((d) => d.key),
      revoked: revoked.map((d) => d.key),
      enrol: true,
    });

    const dialOf = async (ctl: SocketChannel) => JSON.parse(String(await ctl.next())) as { type: string; id: string; enrol?: unknown };

    it('hands out a single-use challenge that a browser page may read', async () => {
      const first = await host.get(`/${host.account}?role=challenge`);
      expect(first.status).toBe(200);
      expect(first.headers['access-control-allow-origin']).toBe('*');
      expect(first.headers['cache-control']).toBe('no-store');
      const second = await host.get(`/${host.account}?role=challenge`);
      expect(JSON.parse(first.body).nonce === JSON.parse(second.body).nonce).toBe(false);
      expect((await host.get('/nobody?role=challenge')).status).toBe(404);
    });

    it('refuses to upgrade a challenge request with 400: a challenge is fetched', async () => {
      expect((await upgrade(`/${host.account}?role=challenge`)).status).toBe(400);
      expect((await upgrade('/nobody?role=challenge')).status).toBe(404);
    });

    it('admits an enrolled device key signed over a fresh challenge', async () => {
      const ctl = await control();
      const phone = newDevice();
      await publish(ctl, closedPolicy([phone]));
      const pending = upgrade(await devicePath(phone));
      const dialed = await dialOf(ctl);
      expect(dialed.enrol === undefined).toBe(true);
      await open(`/${host.account}?role=dial`, signed('dial', dialed.id));
      expect((await pending).status).toBe(101);
    });

    it('keeps a challenge valid however many are handed out after it', async () => {
      const ctl = await control();
      const phone = newDevice();
      await publish(ctl, closedPolicy([phone]));
      const nonce = await challenge();
      for (let i = 0; i < 40; i += 1) await challenge();
      const pending = upgrade(await devicePath(phone, { nonce }));
      const { id } = await dialOf(ctl);
      await open(`/${host.account}?role=dial`, signed('dial', id));
      expect((await pending).status).toBe(101);
    });

    it('refuses a reused or unknown challenge, and a signature by another key, with 4401', async () => {
      const ctl = await control();
      const phone = newDevice();
      await publish(ctl, closedPolicy([phone]));
      const nonce = await challenge();
      const pending = upgrade(await devicePath(phone, { nonce }));
      const { id } = await dialOf(ctl);
      await open(`/${host.account}?role=dial`, signed('dial', id));
      expect((await pending).status).toBe(101);
      expect(await refused(await devicePath(phone, { nonce }))).toEqual({ code: 4401, reason: REFUSAL.challenge });
      expect(await refused(await devicePath(phone, { nonce: 'never-issued' }))).toEqual({ code: 4401, reason: REFUSAL.challenge });
      const forged = await devicePath(newDevice());
      const stolenSig = new URLSearchParams(forged.split('?')[1]).get('sig')!;
      expect(await refused(await devicePath(phone, { sig: stolenSig }))).toEqual({ code: 4401, reason: REFUSAL.signature });
      expect(await ctl.quiet()).toBe(true);
    });

    // The gate: the challenge on the phone's own socket, answered there.
    const gate = async (): Promise<{ socket: SocketChannel; nonce: string }> => {
      const socket = await open(`/${host.account}?${GATE_PARAM}=1`);
      const nonce = parseGateChallenge(text(await socket.next()));
      expect(typeof nonce).toBe('string');
      return { socket, nonce: nonce! };
    };

    const answerGate = async (socket: SocketChannel, device: Device, nonce: string) => {
      const sig = await signDeviceAuth(device.sign, { account: host.account, nonce, device: device.key });
      socket.send(encodeGateReply({ key: device.key, nonce, sig }));
    };

    it('hands a challenge out on the socket of a phone that asks for it, and says ready once the agent dials', async () => {
      const ctl = await control();
      const phone = newDevice();
      await publish(ctl, closedPolicy([phone]));
      const { socket, nonce } = await gate();
      expect(await ctl.quiet()).toBe(true);
      await answerGate(socket, phone, nonce);
      const dialed = await dialOf(ctl);
      expect(dialed.enrol === undefined).toBe(true);
      const agent = await open(`/${host.account}?role=dial`, signed('dial', dialed.id));
      expect(text(await socket.next())).toBe(GATE_READY);
      socket.send(Uint8Array.of(1, 2, 3));
      expect(bytes(await agent.next())).toEqual([1, 2, 3]);
      agent.send(Uint8Array.of(4));
      expect(bytes(await socket.next())).toEqual([4]);
    });

    it('pairs a phone that passed the gate with a spare at once', async () => {
      const ctl = await control();
      const phone = newDevice();
      await publish(ctl, closedPolicy([phone]));
      const spare = await open(`/${host.account}?role=spare`, signed('spare', 'spare-1'));
      const { socket, nonce } = await gate();
      await answerGate(socket, phone, nonce);
      expect(text(await socket.next())).toBe(GATE_READY);
      expect(text(await spare.next())).toBe('paired');
      socket.send(Uint8Array.of(7));
      expect(bytes(await spare.next())).toEqual([7]);
    });

    it('refuses an answer at the gate as it refuses the same proof in a query, and never asks the agent', async () => {
      const ctl = await control();
      const phone = newDevice();
      await publish(ctl, closedPolicy([phone]));
      const spent = await challenge();
      const pending = upgrade(await devicePath(phone, { nonce: spent }));
      await open(`/${host.account}?role=dial`, signed('dial', (await dialOf(ctl)).id));
      expect((await pending).status).toBe(101);
      const reused = await gate();
      await answerGate(reused.socket, phone, spent);
      expect(await reused.socket.closedWith()).toEqual({ code: 4401, reason: REFUSAL.challenge });
      const stranger = await gate();
      await answerGate(stranger.socket, newDevice(), stranger.nonce);
      expect(await stranger.socket.closedWith()).toEqual({ code: 4403, reason: REFUSAL.notEnrolled });
      expect(await ctl.quiet()).toBe(true);
    });

    it('closes a gate on anything but its answer, and forwards nothing from it', async () => {
      const ctl = await control();
      await publish(ctl, closedPolicy([newDevice()]));
      const spare = await open(`/${host.account}?role=spare`, signed('spare', 'spare-1'));
      const binary = await gate();
      binary.socket.send(Uint8Array.of(1));
      expect(await binary.socket.closedWith()).toEqual({ code: 4400, reason: REFUSAL.invalidReply });
      const garbled = await gate();
      garbled.socket.send('{"type":"device"}');
      expect(await garbled.socket.closedWith()).toEqual({ code: 4400, reason: REFUSAL.invalidReply });
      expect(await spare.quiet()).toBe(true);
      expect(await ctl.quiet()).toBe(true);
    });

    it('refuses a gate for an unknown account in band, before any challenge', async () => {
      expect(await refused(`/nobody?${GATE_PARAM}=1`)).toEqual({ code: 4404, reason: REFUSAL.unknownAccount });
    });

    it('refuses an unknown key without an enrolment proof with 4403, and never asks the agent', async () => {
      const ctl = await control();
      await publish(ctl, closedPolicy([newDevice()]));
      expect(await refused(await devicePath(newDevice()))).toEqual({ code: 4403, reason: REFUSAL.notEnrolled });
      expect(await ctl.quiet()).toBe(true);
    });

    it('hands an unknown key with an enrolment proof to the agent, which dials to enrol it', async () => {
      const ctl = await control();
      await publish(ctl, closedPolicy());
      const phone = newDevice();
      const pending = upgrade(await devicePath(phone, { proof: true, cred: 'pairing' }));
      const dialed = await dialOf(ctl);
      const enrol = dialed.enrol as { device: string; nonce: string; proof: string; cred?: string };
      expect(enrol.device).toBe(phone.key);
      expect(enrol.cred).toBe('pairing');
      await open(`/${host.account}?role=dial`, signed('dial', dialed.id));
      expect((await pending).status).toBe(101);
    });

    it("fails the client with 4403 at once when the agent refuses the enrolment, with the agent's reason", async () => {
      const ctl = await control();
      await publish(ctl, closedPolicy());
      const pending = upgrade(await devicePath(newDevice(), { proof: true, token: 'a-wrong-token' }));
      const { id } = await dialOf(ctl);
      ctl.send(JSON.stringify({ type: 'refuse', id, reason: REFUSAL.codeExpired }));
      expect(await refusalOf(pending)).toEqual({ code: 4403, reason: REFUSAL.codeExpired });
    });

    // The agent's own bound on enrolment checks, past which it refuses without reading its files.
    it("passes on the agent's own enrolment cap as its reason", async () => {
      const ctl = await control();
      await publish(ctl, closedPolicy());
      const pending = upgrade(await devicePath(newDevice(), { proof: true, cred: 'pairing' }));
      const { id } = await dialOf(ctl);
      ctl.send(JSON.stringify({ type: 'refuse', id, reason: REFUSAL.tooManyEnrolments }));
      expect(await refusalOf(pending)).toEqual({ code: 4403, reason: REFUSAL.tooManyEnrolments });
    });

    // The agent drops a dial whose id, or an enrolment whose nonce, is not token characters.
    it('mints dial ids and challenge nonces in the characters the agent accepts', async () => {
      const token = /^[A-Za-z0-9_-]{1,128}$/;
      const ctl = await control();
      const phone = newDevice();
      await publish(ctl, closedPolicy([phone]));
      void upgrade(await devicePath(phone));
      const { id } = await dialOf(ctl);
      expect(token.test(id)).toBe(true);
      for (let i = 0; i < 5; i += 1) expect(token.test(await challenge())).toBe(true);
    });

    it('says only that the enrolment was refused when the agent gives no reason it knows', async () => {
      const ctl = await control();
      await publish(ctl, closedPolicy());
      const pending = upgrade(await devicePath(newDevice(), { proof: true }));
      const { id } = await dialOf(ctl);
      ctl.send(JSON.stringify({ type: 'refuse', id, reason: 'anything at all' }));
      expect(await refusalOf(pending)).toEqual({ code: 4403, reason: REFUSAL.enrolmentRefused });
    });

    it('refuses an unknown key with a proof while the agent has closed enrolment, and says so', async () => {
      const ctl = await control();
      await publish(ctl, { ...closedPolicy(), enrol: false });
      expect(await refused(await devicePath(newDevice(), { proof: true, cred: 'pairing' }))).toEqual({
        code: 4403,
        reason: REFUSAL.enrolmentClosed,
      });
      expect(await ctl.quiet()).toBe(true);
    });

    it('refuses a token proof while token enrolment is off, and never asks the agent', async () => {
      const ctl = await control();
      await publish(ctl, { ...closedPolicy(), tokenEnrol: false });
      expect(await refused(await devicePath(newDevice(), { proof: true, cred: 'token' }))).toEqual({
        code: 4403,
        reason: REFUSAL.enrolmentOff,
      });
      expect(await ctl.quiet()).toBe(true);
    });

    // The relay cannot tell a pairing proof from a token proof; it goes by what the phone says,
    // and leaves a proof that says nothing to the agent, which can tell.
    it('still hands a pairing proof, or one that names no credential, to the agent while token enrolment is off', async () => {
      const ctl = await control();
      await publish(ctl, { ...closedPolicy(), tokenEnrol: false });
      for (const cred of ['pairing', undefined]) {
        const pending = upgrade(await devicePath(newDevice(), { proof: true, ...(cred ? { cred } : {}) }));
        const dialed = await dialOf(ctl);
        expect(dialed.enrol === undefined).toBe(false);
        await open(`/${host.account}?role=dial`, signed('dial', dialed.id));
        expect((await pending).status).toBe(101);
      }
    });

    it('refuses a revoked key with 4403, even with an enrolment proof', async () => {
      const ctl = await control();
      const lost = newDevice();
      await publish(ctl, closedPolicy([], [lost]));
      expect(await refused(await devicePath(lost, { proof: true }))).toEqual({ code: 4403, reason: REFUSAL.revoked });
      expect(await ctl.quiet()).toBe(true);
    });

    it('refuses a client without a device key once a policy is published, even one an older agent marks anonymous', async () => {
      const ctl = await control();
      await publish(ctl, { ...closedPolicy(), anonymous: true });
      expect(await refused(clientPath())).toEqual({ code: 4401, reason: REFUSAL.deviceKeyRequired });
      expect(await ctl.quiet()).toBe(true);
    });

    it('keeps the policy in force when the control socket drops and another takes over', async () => {
      const first = await control();
      await publish(first, closedPolicy());
      await control();
      expect(await first.closed()).toBe(SUPERSEDED);
      expect((await refused(clientPath())).code).toBe(4401);
      expect((await refused(await devicePath(newDevice()))).code).toBe(4403);
    });

    // Every test gets its own client address, so the join rate limit of one never spends another's.
    let address: number | string = 0;
    const admin = (method: 'GET' | 'POST', path: string, headers: Record<string, string> = {}) =>
      host.fetch(method, path, { 'cf-connecting-ip': typeof address === 'number' ? `198.51.100.${address}` : address, ...headers });

    const newMachine = () => {
      const keys = generateAgentKeys();
      return { keys, account: accountId(keys.ed25519.publicKey) };
    };
    type Machine = ReturnType<typeof newMachine>;

    const join = (machine: Machine, options: { joinKey?: string; account?: string } = {}) => {
      const account = options.account ?? machine.account;
      const now = Date.now();
      return admin('POST', `/${account}?role=join&key=${machine.keys.ed25519.publicKey}`, {
        authorization: signAgentAuth(machine.keys.ed25519.privateKey, { account, role: 'join' }, now),
        [JOIN_HEADER]: signJoinAuth(options.joinKey ?? host.joinKey, { account, role: 'join' }, now),
      });
    };

    const listMachines = async (key = host.adminKey) => {
      const res = await admin('GET', '/?role=machines', { [JOIN_HEADER]: signJoinAuth(key, { account: '*', role: 'machines' }, Date.now()) });
      return { status: res.status, accounts: res.status === 200 ? (JSON.parse(res.body) as Array<{ account: string }>).map((e) => e.account) : [] };
    };

    const removeMachine = (account: string, key = host.adminKey) =>
      admin('POST', `/${account}?role=remove`, { [JOIN_HEADER]: signJoinAuth(key, { account, role: 'remove' }, Date.now()) });

    const allowMachine = (account: string, key = host.adminKey) =>
      admin('POST', `/${account}?role=allow`, { [JOIN_HEADER]: signJoinAuth(key, { account, role: 'allow' }, Date.now()) });

    const controlOf = (machine: Machine) =>
      upgrade(`/${machine.account}?role=agent`, {
        authorization: signAgentAuth(machine.keys.ed25519.privateKey, { account: machine.account, role: 'agent' }, Date.now()),
      });

    it('registers a machine that proves its own key and the join key, and serves it at once', async () => {
      address = 1;
      const machine = newMachine();
      expect(await host.request(`/${machine.account}`)).toBe(404);
      expect((await join(machine)).status).toBe(201);
      expect((await join(machine)).status).toBe(200);
      expect(await host.request(`/${machine.account}`)).toBe(426);
      expect((await controlOf(machine)).status).toBe(101);
    });

    it('refuses a wrong join key with 401, and the account stays unknown', async () => {
      address = 2;
      const machine = newMachine();
      expect((await join(machine, { joinKey: generateAgentKeys().x25519.privateKey })).status).toBe(401);
      expect(await host.request(`/${machine.account}`)).toBe(404);
      expect((await controlOf(machine)).status).toBe(404);
    });

    it('refuses an account id that is not derived from the key it registers', async () => {
      address = 3;
      const machine = newMachine();
      expect((await join(machine, { account: 'a-chosen-name' })).status).toBe(400);
      expect(await host.request('/a-chosen-name')).toBe(404);
    });

    it('lists and removes machines with the admin key; a removed one is closed with 4004, then unknown', async () => {
      address = 4;
      const machine = newMachine();
      await join(machine);
      const listed = await listMachines();
      expect(listed.status).toBe(200);
      expect(listed.accounts.includes(machine.account)).toBe(true);
      expect((await listMachines(generateAgentKeys().x25519.privateKey)).status).toBe(401);
      const { socket } = await controlOf(machine);
      expect((await removeMachine(machine.account)).status).toBe(200);
      expect(await socket!.closed()).toBe(ACCOUNT_REMOVED);
      expect(await host.request(`/${machine.account}`)).toBe(404);
    });

    // Whoever stole the machine's agent key holds the join key too (every machine does): a removal
    // must hold against both, until the operator lifts it with the admin key.
    it('refuses a removed machine that joins again, until the admin key allows it', async () => {
      address = 11;
      const machine = newMachine();
      await join(machine);
      expect((await removeMachine(machine.account)).status).toBe(200);
      expect((await join(machine)).status).toBe(403);
      expect(await host.request(`/${machine.account}`)).toBe(404);
      expect((await host.get(`/${machine.account}?role=challenge`)).status).toBe(404);
      expect((await controlOf(machine)).status).toBe(404);
      const listed = await admin('GET', '/?role=machines', {
        [JOIN_HEADER]: signJoinAuth(host.adminKey, { account: '*', role: 'machines' }, Date.now()),
      });
      const entry = (JSON.parse(listed.body) as Array<{ account: string; removedAt?: string }>).find((e) => e.account === machine.account);
      expect(typeof entry?.removedAt).toBe('string');
      address = 12;
      expect((await allowMachine(machine.account, host.joinKey)).status).toBe(401);
      expect((await allowMachine(machine.account)).status).toBe(200);
      expect((await allowMachine(machine.account)).status).toBe(404);
      expect((await join(machine)).status).toBe(201);
      expect((await host.get(`/${machine.account}?role=challenge`)).status).toBe(200);
      expect((await controlOf(machine)).status).toBe(101);
    });

    // The join key every joining machine holds must reach no other account.
    it('refuses to list or remove machines with the join key', async () => {
      address = 8;
      const machine = newMachine();
      await join(machine);
      expect((await listMachines(host.joinKey)).status).toBe(401);
      expect((await removeMachine(machine.account, host.joinKey)).status).toBe(401);
      expect(await host.request(`/${machine.account}`)).toBe(426);
    });

    it('rate-limits join-key requests per client address with 429, and never another address', async () => {
      address = 5;
      const machine = newMachine();
      const wrong = generateAgentKeys().x25519.privateKey;
      for (let i = 0; i < host.joinMax; i += 1) expect((await join(machine, { joinKey: wrong })).status).toBe(401);
      expect((await join(machine)).status).toBe(429);
      address = 6;
      expect((await join(machine)).status).toBe(201);
    });

    // One subscriber holds a whole IPv6 /64, and a dual-stack host may name an IPv4 client in
    // IPv6 form: both must spend one budget, not one per spelling.
    it('rate-limits an IPv6 client by its /64, and an IPv4-mapped one as its IPv4 address', async () => {
      const machine = newMachine();
      const wrong = generateAgentKeys().x25519.privateKey;
      address = '2001:db8:9:9::1';
      for (let i = 0; i < host.joinMax; i += 1) expect((await join(machine, { joinKey: wrong })).status).toBe(401);
      address = '2001:0db8:0009:0009:ffff::2';
      expect((await join(machine)).status).toBe(429);
      address = '::ffff:198.51.100.9';
      for (let i = 0; i < host.joinMax; i += 1) expect((await join(machine, { joinKey: wrong })).status).toBe(401);
      address = '198.51.100.9';
      expect((await join(machine)).status).toBe(429);
      address = '2001:db8:9:a::1';
      expect((await join(machine)).status).toBe(201);
    });

    it('refuses a tampered challenge, and one handed out for another account, with 4401', async () => {
      address = 7;
      const ctl = await control();
      const phone = newDevice();
      await publish(ctl, closedPolicy([phone]));
      const nonce = await challenge();
      const flipped = `${nonce.slice(0, 5)}${nonce[5] === 'A' ? 'B' : 'A'}${nonce.slice(6)}`;
      expect(await refused(await devicePath(phone, { nonce: flipped }))).toEqual({ code: 4401, reason: REFUSAL.challenge });
      const other = newMachine();
      expect((await join(other)).status).toBe(201);
      const { body } = await host.get(`/${other.account}?role=challenge`);
      const foreign = (JSON.parse(body) as { nonce: string }).nonce;
      expect(await refused(await devicePath(phone, { nonce: foreign }))).toEqual({ code: 4401, reason: REFUSAL.challenge });
      expect(await ctl.quiet()).toBe(true);
    });

    it('ignores a malformed control message', async () => {
      const ctl = await control();
      await publish(ctl, closedPolicy());
      ctl.send('{"type":"policy","devices":"everyone"}');
      expect(await ctl.quiet()).toBe(true);
      expect((await refused(clientPath())).code).toBe(4401);
    });

    // Last: the budget is per account and per minute, and a host that keeps its relay in memory
    // between tests has spent some of it already, so this counts to the refusal from wherever it is.
    it('caps the enrolment dials of one account with 4429, without asking the agent', async () => {
      const ctl = await control();
      await publish(ctl, closedPolicy());
      let refusal: { code: number; reason: string } | null = null;
      for (let i = 0; i <= host.limits.maxEnrolments && !refusal; i += 1) {
        const pending = upgrade(await devicePath(newDevice(), { proof: true, cred: 'pairing' }));
        const dial = await ctl.next(1500).catch(() => null);
        if (dial !== null) {
          const { id } = JSON.parse(String(dial)) as { id: string };
          ctl.send(JSON.stringify({ type: 'refuse', id }));
          expect((await refusalOf(pending)).code).toBe(4403);
        } else {
          refusal = await refusalOf(pending);
        }
      }
      expect(refusal).toEqual({ code: 4429, reason: REFUSAL.tooManyEnrolments });
      expect(await ctl.quiet()).toBe(true);
    });
  });
}
