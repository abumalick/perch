import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_REMOVED,
  CHALLENGE_TTL_MS,
  MemoryStore,
  MemoryDirectory,
  Relay,
  parseRelayRequest,
  type Peer,
  type PeerLabel,
  type PendingUpgrade,
  type RelayData,
} from './relay.ts';
import {
  GATE_READY,
  MAX_GATE_REPLY_BYTES,
  REFUSAL,
  ed25519Signer,
  encodeGateReply,
  enrolKey,
  enrolProof,
  generateDeviceKeys,
  parseGateChallenge,
  signDeviceAuth,
} from '@perch/secure-channel';

class FakePeer implements Peer {
  sent: Array<{ data: RelayData; binary: boolean }> = [];
  closedWith: { code?: number; reason?: string } | null = null;

  send(data: RelayData, binary: boolean): void {
    this.sent.push({ data, binary });
  }
  close(code?: number, reason?: string): void {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
  }
}

class FakeUpgrade implements PendingUpgrade {
  peer: FakePeer | null = null;
  label: PeerLabel | null = null;
  rejected: { status: number; reason: string } | null = null;
  refused: { code: number; reason: string } | null = null;
  gone = false;
  private abortListeners: Array<() => void> = [];

  constructor(private readonly directory: MemoryDirectory) {}

  accept(label: PeerLabel): Peer | null {
    if (this.gone) return null;
    const peer = new FakePeer();
    this.peer = peer;
    this.label = label;
    this.directory.add(peer, label, () => peer.closedWith === null);
    return peer;
  }
  reject(status: number, reason: string): void {
    this.rejected = { status, reason };
  }
  refuse(code: number, reason: string): void {
    this.refused = { code, reason };
  }
  onAbort(listener: () => void): void {
    this.abortListeners.push(listener);
  }
  abort(): void {
    this.gone = true;
    this.abortListeners.forEach((l) => l());
  }
}

interface Limits {
  maxEnrolments?: number;
  maxPending?: number;
  maxPairs?: number;
  maxFrameBytes?: number;
  gateTimeoutMs?: number;
}

function setup(limits: Limits = {}) {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  let next = 0;
  const directory = new MemoryDirectory();
  const deps = {
    directory,
    newId: () => `id${++next}`,
    startTimer: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    dialTimeoutMs: 10_000,
    ...limits,
  };
  const relay = new Relay(deps);
  const fireTimers = () => timers.filter((t) => !t.cancelled).forEach((t) => t.fn());
  const upgrade = () => new FakeUpgrade(directory);
  // What an adapter does when a socket goes away: the core is told while the directory can
  // still name the socket, then the directory forgets it.
  const drop = (peer: FakePeer, code: number, reason = '', on: Relay = relay) => {
    peer.closedWith = { code, reason };
    on.closed(peer, code, reason);
    directory.remove(peer);
  };
  return { relay, deps, directory, timers, fireTimers, upgrade, drop };
}

type Setup = ReturnType<typeof setup>;

function withAgent(s: Setup): FakePeer {
  const control = s.upgrade();
  s.relay.handle({ role: 'agent', account: 'acct' }, control);
  return control.peer!;
}

function connectClient(s: Setup): FakeUpgrade {
  const client = s.upgrade();
  s.relay.handle({ role: 'client', account: 'acct' }, client);
  return client;
}

function dial(s: Setup, id: string): FakeUpgrade {
  const up = s.upgrade();
  s.relay.handle({ role: 'dial', account: 'acct', id }, up);
  return up;
}

function spare(s: Setup, id: string): FakeUpgrade {
  const up = s.upgrade();
  s.relay.handle({ role: 'spare', account: 'acct', id }, up);
  return up;
}

function pair(s: Setup) {
  const control = withAgent(s);
  const client = connectClient(s);
  const id = (JSON.parse(control.sent.at(-1)!.data as string) as { id: string }).id;
  const agent = dial(s, id);
  return { control, client: client.peer!, agent: agent.peer! };
}

// Until `done` holds: the device signature check is asynchronous.
async function until(done: () => unknown): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) await new Promise((r) => setTimeout(r, 5));
}

const headers =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    values[name];

describe('parseRelayRequest', () => {
  it('reads a client from the account path', () => {
    expect(parseRelayRequest('/acct')).toEqual({ role: 'client', account: 'acct' });
  });

  it('reads the agent control socket with its authorization', () => {
    expect(parseRelayRequest('/acct?role=agent', headers({ authorization: 'sig' }))).toEqual({
      role: 'agent',
      account: 'acct',
      authorization: 'sig',
    });
  });

  it('takes a dial id from its header only, never from the URL', () => {
    expect(
      parseRelayRequest('/acct?role=dial', headers({ authorization: 'sig', 'x-perch-dial': 'abc' })),
    ).toEqual({ role: 'dial', account: 'acct', id: 'abc', authorization: 'sig' });
    expect(parseRelayRequest('/acct?role=dial&id=abc')).toBeNull();
  });

  it('reads a spare, its id from the dial header in the characters a pair tag can carry', () => {
    expect(
      parseRelayRequest('/acct?role=spare', headers({ authorization: 'sig', 'x-perch-dial': 'spare-1' })),
    ).toEqual({ role: 'spare', account: 'acct', id: 'spare-1', authorization: 'sig' });
    expect(parseRelayRequest('/acct?role=spare')).toBeNull();
    expect(parseRelayRequest('/acct?role=spare', headers({ 'x-perch-dial': 'a:b' }))).toBeNull();
    expect(parseRelayRequest('/acct?role=spare', headers({ 'x-perch-dial': 'a'.repeat(65) }))).toBeNull();
  });

  it('reads a device key, nonce, signature and optional enrolment proof from the query', () => {
    const [K, S] = ['K'.repeat(43), 'S'.repeat(86)];
    expect(parseRelayRequest(`/acct?device=${K}&nonce=N&sig=${S}`)).toEqual({
      role: 'client',
      account: 'acct',
      device: { key: K, nonce: 'N', sig: S },
    });
    expect(parseRelayRequest(`/acct?device=${K}&nonce=N&sig=${S}&proof=P`)).toMatchObject({ device: { proof: 'P' } });
    expect(parseRelayRequest(`/acct?device=${K}&nonce=N&sig=${S}&proof=P&cred=pairing`)).toMatchObject({ device: { cred: 'pairing' } });
    expect(parseRelayRequest(`/acct?device=${K}&nonce=N&sig=${S}&proof=P&cred=magic`)).toEqual({
      role: 'client',
      account: 'acct',
      device: { key: K, nonce: 'N', sig: S, proof: 'P' },
    });
    expect(parseRelayRequest(`/acct?device=${K}&nonce=N`)).toBeNull();
    // Shapes the agent would refuse are refused here, before they hold a pending slot.
    expect(parseRelayRequest(`/acct?device=short&nonce=N&sig=${S}`)).toBeNull();
    expect(parseRelayRequest(`/acct?device=${K}&nonce=N&sig=${S}&proof=${'p'.repeat(129)}`)).toBeNull();
    expect(parseRelayRequest(`/acct?device=${K}&nonce=${'n'.repeat(129)}&sig=${S}`)).toBeNull();
    expect(parseRelayRequest('/acct?role=challenge')).toEqual({ role: 'challenge', account: 'acct' });
  });

  it('reads a client asking for the in-band gate, which carries no device parameters', () => {
    expect(parseRelayRequest('/acct?challenge=1')).toEqual({ role: 'client', account: 'acct', inBand: true });
    expect(parseRelayRequest('/acct?challenge=yes')).toEqual({ role: 'client', account: 'acct' });
    expect(parseRelayRequest(`/acct?challenge=1&device=${'K'.repeat(43)}&nonce=N&sig=${'S'.repeat(86)}`)).toBeNull();
  });

  it('rejects anything else', () => {
    expect(parseRelayRequest('/')).toBeNull();
    expect(parseRelayRequest('/a/b')).toBeNull();
    expect(parseRelayRequest('/acct?role=dial')).toBeNull();
    expect(parseRelayRequest('/acct?role=admin')).toBeNull();
    expect(parseRelayRequest(`/${'a'.repeat(65)}`)).toBeNull();
  });

  it('rejects paths the URL parser cannot read instead of throwing', () => {
    for (const path of ['//[', '//a^b', '//a%zz', '//', '']) {
      expect(() => parseRelayRequest(path)).not.toThrow();
      expect(parseRelayRequest(path)).toBeNull();
    }
  });
});

describe('Relay challenges', () => {
  function clock() {
    let now = 1_000_000;
    let n = 0;
    const directory = new MemoryDirectory();
    const store = new MemoryStore();
    let writes = 0;
    const put = store.put.bind(store);
    store.put = (key, value) => {
      writes += 1;
      put(key, value);
    };
    const relay = new Relay({ directory, store, newId: () => `n${++n}`, startTimer: () => () => undefined, now: () => now });
    const device = (nonce: string) => {
      const up = new FakeUpgrade(directory);
      relay.handle({ role: 'client', account: 'acct', device: { key: 'K'.repeat(43), nonce, sig: 'S'.repeat(86) } }, up);
      return up;
    };
    return { relay, device, advance: (ms: number) => (now += ms), writes: () => writes };
  }

  it('refuses a challenge once it has expired', async () => {
    const c = clock();
    const nonce = c.relay.challenge('acct')!;
    c.advance(CHALLENGE_TTL_MS + 1);
    const up = c.device(nonce);
    await until(() => up.refused);
    expect(up.refused).toEqual({ code: 4401, reason: 'unknown or expired challenge' });
  });

  it('keeps every challenge it hands out valid, however many follow it', async () => {
    const c = clock();
    const first = c.relay.challenge('acct')!;
    for (let i = 0; i < 100; i += 1) c.relay.challenge('acct')!;
    const up = c.device(first);
    await until(() => up.refused);
    expect(up.refused?.reason).toBe('device signature invalid');
  });

  it('refuses a challenge the second time, and one made for another account', async () => {
    const c = clock();
    const nonce = c.relay.challenge('acct')!;
    const first = c.device(nonce);
    await until(() => first.refused);
    expect(first.refused?.reason).toBe('device signature invalid');
    const again = c.device(nonce);
    await until(() => again.refused);
    expect(again.refused?.reason).toBe('unknown or expired challenge');
    const other = c.device(c.relay.challenge('other')!);
    await until(() => other.refused);
    expect(other.refused?.reason).toBe('unknown or expired challenge');
  });

  it('writes its key once and nothing per challenge', () => {
    const c = clock();
    c.relay.challenge('acct')!;
    const writes = c.writes();
    for (let i = 0; i < 10; i += 1) c.relay.challenge('acct')!;
    expect(c.writes()).toBe(writes);
    expect(writes).toBe(1);
  });

  it('refuses to upgrade the challenge route', () => {
    const c = clock();
    const up = new FakeUpgrade(new MemoryDirectory());
    c.relay.handle({ role: 'challenge', account: 'acct' }, up);
    expect(up.rejected?.status).toBe(400);
  });
});

describe('Relay', () => {
  it('refuses a client when no agent holds the account', () => {
    const s = setup();
    const client = connectClient(s);
    expect(client.refused?.code).toBe(4503);
    expect(client.peer).toBeNull();
  });

  // A browser's WebSocket reports 1006 for any refused upgrade, whatever its status and body.
  it('refuses a phone in band, with 4000 + the status and the reason, and never files its socket', () => {
    const s = setup();
    const client = connectClient(s);
    expect(client.refused).toEqual({ code: 4503, reason: 'agent offline' });
    expect(client.rejected).toBeNull();
    expect(s.directory.all()).toEqual([]);
  });

  it('refuses the agent roles over HTTP, as before', () => {
    const s = setup();
    expect(dial(s, 'nope').rejected).toEqual({ status: 404, reason: 'no such pending client' });
  });

  it("passes the agent's reason for refusing an enrolment on to the phone", () => {
    const s = setup();
    const control = withAgent(s);
    const client = connectClient(s);
    s.relay.message(control, JSON.stringify({ type: 'refuse', id: 'id1', reason: 'pairing code expired' }), false);
    expect(client.refused).toEqual({ code: 4403, reason: 'pairing code expired' });
  });

  it('says only that the enrolment was refused when an older agent gives no reason', () => {
    const s = setup();
    const control = withAgent(s);
    const client = connectClient(s);
    s.relay.message(control, JSON.stringify({ type: 'refuse', id: 'id1' }), false);
    expect(client.refused).toEqual({ code: 4403, reason: 'enrolment refused' });
  });

  it('asks the agent to dial and holds the client upgrade until it does', () => {
    const s = setup();
    const control = withAgent(s);
    const client = connectClient(s);
    expect(control.sent).toEqual([{ data: JSON.stringify({ type: 'dial', id: 'id1' }), binary: false }]);
    expect(client.peer).toBeNull();
    expect(client.refused).toBeNull();
  });

  it('labels the paired sockets so a directory can find each one from the other', () => {
    const s = setup();
    const control = withAgent(s);
    const client = connectClient(s);
    const agent = dial(s, 'id1');
    expect(s.directory.labelOf(control)).toEqual({ kind: 'control' });
    expect(client.label).toEqual({ kind: 'client', pair: 'id1' });
    expect(agent.label).toEqual({ kind: 'agent', pair: 'id1' });
  });

  it('forwards frames verbatim both ways once paired, keeping the binary flag', () => {
    const s = setup();
    const { client, agent } = pair(s);
    const bytes = Uint8Array.of(1, 2, 3);
    s.relay.message(client, bytes, true);
    s.relay.message(agent, 'text', false);
    expect(agent.sent).toEqual([{ data: bytes, binary: true }]);
    expect(client.sent).toEqual([{ data: 'text', binary: false }]);
  });

  it('keeps forwarding for a relay rebuilt over the same directory, as after hibernation', () => {
    const s = setup();
    const { control, client, agent } = pair(s);
    const woken = new Relay({ ...s.deps });
    woken.message(client, 'after', false);
    expect(agent.sent).toEqual([{ data: 'after', binary: false }]);
    // The woken relay still finds the control socket for a new client.
    const next = s.upgrade();
    woken.handle({ role: 'client', account: 'acct' }, next);
    expect(control.sent.at(-1)?.data).toBe(JSON.stringify({ type: 'dial', id: 'id2' }));
    s.drop(agent, 4001, 'bye', woken);
    expect(client.closedWith).toEqual({ code: 4001, reason: 'bye' });
  });

  it('closes the other side when one side closes, passing on a sendable code', () => {
    const s = setup();
    const { client, agent } = pair(s);
    s.drop(agent, 4001, 'bye');
    expect(client.closedWith).toEqual({ code: 4001, reason: 'bye' });
  });

  it('maps a close code that cannot be sent (abnormal closure) to going-away', () => {
    const s = setup();
    const { client, agent } = pair(s);
    s.drop(client, 1006);
    expect(agent.closedWith).toEqual({ code: 1001, reason: '' });
  });

  it('closes a socket whose partner is already gone instead of dropping its frames silently', () => {
    const s = setup();
    const { client, agent } = pair(s);
    agent.closedWith = { code: 1006 };
    s.directory.remove(agent);
    s.relay.message(client, 'orphan', false);
    expect(client.closedWith?.code).toBe(1001);
  });

  it('times out a client whose agent never dials', () => {
    const s = setup();
    withAgent(s);
    const client = connectClient(s);
    s.fireTimers();
    expect(client.refused?.code).toBe(4504);
    expect(dial(s, 'id1').rejected?.status).toBe(404);
  });

  it('drops a pending client that hangs up before the dial, and refuses that dial', () => {
    const s = setup();
    withAgent(s);
    const client = connectClient(s);
    client.abort();
    expect(s.timers[0]?.cancelled).toBe(true);
    expect(dial(s, 'id1').rejected?.status).toBe(404);
  });

  it('refuses a dial for an unknown id', () => {
    const s = setup();
    withAgent(s);
    const client = connectClient(s);
    expect(dial(s, 'nope').rejected?.status).toBe(404);
    expect(client.peer).toBeNull();
  });

  it('refuses the dial when the client vanished just before accept', () => {
    const s = setup();
    withAgent(s);
    const client = connectClient(s);
    client.gone = true;
    const agent = dial(s, 'id1');
    expect(agent.rejected?.status).toBe(410);
    expect(agent.peer).toBeNull();
  });

  it('closes the client when the dialing agent vanished just before accept', () => {
    const s = setup();
    withAgent(s);
    const client = connectClient(s);
    const agent = s.upgrade();
    agent.gone = true;
    s.relay.handle({ role: 'dial', account: 'acct', id: 'id1' }, agent);
    expect(client.peer?.closedWith?.code).toBe(1001);
  });

  it('lets a new control socket supersede the old one for the same account', () => {
    const s = setup();
    const first = withAgent(s);
    const second = withAgent(s);
    expect(first.closedWith?.code).toBe(4000);
    connectClient(s);
    expect(second.sent).toHaveLength(1);
    expect(first.sent).toHaveLength(0);
  });

  it('forgets the agent once its control socket closes', () => {
    const s = setup();
    const control = withAgent(s);
    s.drop(control, 1006);
    expect(connectClient(s).refused?.code).toBe(4503);
  });

  it('refuses pending clients at once when the control socket they wait on closes', () => {
    const s = setup();
    const control = withAgent(s);
    const client = connectClient(s);
    s.drop(control, 1006);
    expect(client.refused?.code).toBe(4503);
    expect(s.timers[0]?.cancelled).toBe(true);
    expect(dial(s, 'id1').rejected?.status).toBe(404);
  });

  it("refuses the superseded agent's pending clients but keeps serving through its replacement", () => {
    const s = setup();
    const first = withAgent(s);
    const firstClient = connectClient(s);
    const second = withAgent(s);
    expect(firstClient.refused?.code).toBe(4503);
    // The old socket's close arrives only now, after the replacement registered.
    s.drop(first, 4000, 'superseded');
    const secondClient = connectClient(s);
    expect(secondClient.refused).toBeNull();
    expect(second.sent.at(-1)?.data).toBe(JSON.stringify({ type: 'dial', id: 'id2' }));
  });

  it('keeps already-paired sockets up when the control socket drops', () => {
    const s = setup();
    const { control, client, agent } = pair(s);
    s.drop(control, 1006);
    s.relay.message(client, 'x', false);
    expect(agent.sent).toEqual([{ data: 'x', binary: false }]);
    expect(client.closedWith).toBeNull();
  });

  it("answers the agent's control heartbeat and ignores anything else on that socket", () => {
    const s = setup();
    const control = withAgent(s);
    s.relay.message(control, 'ping', false);
    expect(control.sent).toEqual([{ data: 'pong', binary: false }]);
    expect(() => s.relay.message(control, 'not json', false)).not.toThrow();
    expect(control.sent).toHaveLength(1);
  });

  it('answers a text ping on a paired socket too, and never forwards it, as a Durable Object must', () => {
    const s = setup();
    const { client, agent } = pair(s);
    s.relay.message(client, 'ping', false);
    expect(client.sent).toEqual([{ data: 'pong', binary: false }]);
    expect(agent.sent).toEqual([]);
    s.relay.message(client, new TextEncoder().encode('ping'), true);
    expect(agent.sent).toHaveLength(1);
  });

  it('evicts a removed account: every socket closes with 4004, waiting clients fail, the policy is gone', () => {
    const s = setup();
    const store = new MemoryStore();
    const relay = new Relay({ ...s.deps, store });
    const control = s.upgrade();
    relay.handle({ role: 'agent', account: 'acct' }, control);
    const waiting = s.upgrade();
    relay.handle({ role: 'client', account: 'acct' }, waiting);
    relay.message(control.peer!, JSON.stringify({ type: 'policy', devices: [], revoked: [], enrol: true }), false);
    relay.evict();
    expect(control.peer!.closedWith?.code).toBe(ACCOUNT_REMOVED);
    expect(waiting.refused?.code).toBe(4404);
    expect(store.get('policy')).toBe(undefined);
  });

  // A request already past the registry when the account was removed (or answered from a host's
  // stale cache) reaches the account's relay anyway: it must refuse it as unknown, and write
  // nothing back into what eviction cleared.
  it('refuses every role of an evicted account as unknown, until it is reinstated', () => {
    const s = setup();
    const store = new MemoryStore();
    const relay = new Relay({ ...s.deps, store });
    relay.evict();
    const control = s.upgrade();
    relay.handle({ role: 'agent', account: 'acct' }, control);
    expect(control.rejected).toEqual({ status: 404, reason: REFUSAL.unknownAccount });
    expect(control.peer).toBeNull();
    const client = s.upgrade();
    relay.handle({ role: 'client', account: 'acct' }, client);
    expect(client.refused).toEqual({ code: 4404, reason: REFUSAL.unknownAccount });
    const dialing = s.upgrade();
    relay.handle({ role: 'dial', account: 'acct', id: 'x' }, dialing);
    expect(dialing.rejected?.status).toBe(404);
    expect(relay.challenge('acct')).toBeNull();
    expect(store.get('challengeKey')).toBe(undefined);
    relay.reinstate();
    expect(relay.challenge('acct')).not.toBeNull();
    const again = s.upgrade();
    relay.handle({ role: 'agent', account: 'acct' }, again);
    expect(again.peer).not.toBeNull();
  });

  // A Durable Object may still deliver a frame that arrived before eviction closed its socket.
  it('drops a control frame that arrives after eviction, writing nothing back', () => {
    const s = setup();
    const store = new MemoryStore();
    const relay = new Relay({ ...s.deps, store });
    const control = s.upgrade();
    relay.handle({ role: 'agent', account: 'acct' }, control);
    relay.evict();
    relay.message(control.peer!, JSON.stringify({ type: 'policy', devices: [], revoked: [], enrol: true }), false);
    expect(store.get('policy')).toBe(undefined);
    expect(control.peer!.sent.filter((f) => f.data === '{"type":"applied"}')).toEqual([]);
  });

  it('evicts the paired sockets too', () => {
    const s = setup();
    const { client, agent } = pair(s);
    s.relay.evict();
    expect(client.closedWith?.code).toBe(ACCOUNT_REMOVED);
    expect(agent.closedWith?.code).toBe(ACCOUNT_REMOVED);
  });

  it('ignores a frame from a socket it does not know', () => {
    const s = setup();
    expect(() => s.relay.message(new FakePeer(), 'x', false)).not.toThrow();
    expect(() => s.relay.closed(new FakePeer(), 1000, '')).not.toThrow();
  });
});

describe('Relay spares', () => {
  it('pairs a client with a spare the agent opened ahead, telling the spare before any frame', () => {
    const s = setup();
    const control = withAgent(s);
    const filed = spare(s, 's1');
    expect(filed.label).toEqual({ kind: 'agent', pair: 'spare.s1' });
    const client = connectClient(s);
    expect(control.sent).toEqual([]);
    expect(client.label).toEqual({ kind: 'client', pair: 'spare.s1' });
    expect(filed.peer!.sent).toEqual([{ data: 'paired', binary: false }]);
    const bytes = Uint8Array.of(1, 2, 3);
    s.relay.message(client.peer!, bytes, true);
    s.relay.message(filed.peer!, bytes, true);
    expect(filed.peer!.sent.at(-1)).toEqual({ data: bytes, binary: true });
    expect(client.peer!.sent).toEqual([{ data: bytes, binary: true }]);
    expect(s.timers).toEqual([]);
  });

  it('asks the agent to dial once its spares are taken', () => {
    const s = setup();
    const control = withAgent(s);
    spare(s, 's1');
    connectClient(s);
    connectClient(s);
    expect(control.sent).toEqual([{ data: JSON.stringify({ type: 'dial', id: 'id1' }), binary: false }]);
  });

  it('takes the newest spare first', () => {
    const s = setup();
    withAgent(s);
    spare(s, 'old');
    spare(s, 'new');
    expect(connectClient(s).label).toEqual({ kind: 'client', pair: 'spare.new' });
  });

  it('never hands an enrolment to a spare: the agent checks the proof before it dials', async () => {
    const s = setup();
    const control = withAgent(s);
    s.relay.message(control, JSON.stringify({ type: 'policy', devices: [], revoked: [], enrol: true }), false);
    const filed = spare(s, 's1');
    const device = generateDeviceKeys().ed25519;
    const nonce = s.relay.challenge('acct')!;
    const claim = { account: 'acct', nonce, device: device.publicKey };
    const sig = await signDeviceAuth(ed25519Signer(device.privateKey), claim);
    const client = s.upgrade();
    s.relay.handle({ role: 'client', account: 'acct', device: { key: device.publicKey, nonce, sig, proof: enrolProof(enrolKey('t', 'acct'), claim) } }, client);
    await until(() => control.sent.some((m) => String(m.data).includes('"dial"')));
    expect(JSON.parse(control.sent.at(-1)!.data as string)).toMatchObject({ type: 'dial', enrol: { device: device.publicKey } });
    expect(filed.peer!.sent).toEqual([]);
  });

  it('leaves a spare unpaired when the client is gone before it is accepted', () => {
    const s = setup();
    const control = withAgent(s);
    const filed = spare(s, 's1');
    const gone = s.upgrade();
    gone.gone = true;
    s.relay.handle({ role: 'client', account: 'acct' }, gone);
    expect(filed.peer!.sent).toEqual([]);
    expect(connectClient(s).label).toEqual({ kind: 'client', pair: 'spare.s1' });
    expect(control.sent).toEqual([]);
  });

  it('caps the unpaired spares of an account, and a paired one no longer counts', () => {
    const s = setup();
    withAgent(s);
    spare(s, 's1');
    spare(s, 's2');
    expect(spare(s, 's3').rejected?.status).toBe(429);
    connectClient(s);
    expect(spare(s, 's4').peer).not.toBeNull();
  });

  it('refuses a spare whose id an open spare or its pair still holds', () => {
    const s = setup();
    withAgent(s);
    spare(s, 's1');
    expect(spare(s, 's1').rejected?.status).toBe(409);
    connectClient(s);
    expect(spare(s, 's1').rejected?.status).toBe(409);
    // A relay-minted dial id is another namespace.
    connectClient(s);
    expect(spare(s, 'id1').peer).not.toBeNull();
  });

  it('answers a spare ping and closes a spare that sends anything else', () => {
    const s = setup();
    withAgent(s);
    const filed = spare(s, 's1');
    s.relay.message(filed.peer!, 'ping', false);
    expect(filed.peer!.sent).toEqual([{ data: 'pong', binary: false }]);
    s.relay.message(filed.peer!, Uint8Array.of(1), true);
    expect(filed.peer!.closedWith?.code).toBe(1001);
  });

  it('closes the unpaired spares when a new control socket takes over, and dials for the next client', () => {
    const s = setup();
    withAgent(s);
    const filed = spare(s, 's1');
    const paired = spare(s, 's2');
    const client = connectClient(s);
    const control = withAgent(s);
    expect(filed.peer!.closedWith).toEqual({ code: 1001, reason: 'superseded' });
    expect(paired.peer!.closedWith).toBeNull();
    expect(client.peer!.closedWith).toBeNull();
    connectClient(s);
    expect(JSON.parse(control.sent.at(-1)!.data as string)).toMatchObject({ type: 'dial' });
  });

  // A host reports a closed socket only once its close completes; until then a dialed pair's
  // agent socket is open with no open client, and must not pass for a spare.
  it('never takes the agent side of a dialed pair whose client is closing for a spare', () => {
    const s = setup();
    const { control, client } = pair(s);
    client.closedWith = { code: 1000 };
    expect(spare(s, 's1').peer).not.toBeNull();
    expect(spare(s, 's2').peer).not.toBeNull();
    const next = connectClient(s);
    expect(next.label).toEqual({ kind: 'client', pair: 'spare.s2' });
    connectClient(s);
    connectClient(s);
    expect(JSON.parse(control.sent.at(-1)!.data as string)).toMatchObject({ type: 'dial' });
  });

  it('closes the client when its spare closes, as with any pair', () => {
    const s = setup();
    withAgent(s);
    const filed = spare(s, 's1');
    const client = connectClient(s);
    s.drop(filed.peer!, 1006);
    expect(client.peer!.closedWith?.code).toBe(1001);
  });
});

describe('Relay caps', () => {
  it('refuses a client beyond the pending cap without asking the agent to dial', () => {
    const s = setup({ maxPending: 2 });
    const control = withAgent(s);
    connectClient(s);
    connectClient(s);
    const third = connectClient(s);
    expect(third.refused?.code).toBe(4429);
    expect(control.sent).toHaveLength(2);
  });

  it('frees a pending slot once the client is paired', () => {
    const s = setup({ maxPending: 1 });
    pair(s);
    expect(connectClient(s).refused).toBeNull();
  });

  it('refuses a client beyond the live pair cap', () => {
    const s = setup({ maxPairs: 1 });
    const { control } = pair(s);
    const extra = connectClient(s);
    expect(extra.refused?.code).toBe(4429);
    expect(control.sent).toHaveLength(1);
  });

  it('counts clients still waiting for their dial toward the pair cap', () => {
    const s = setup({ maxPending: 8, maxPairs: 3 });
    const { control } = pair(s);
    connectClient(s);
    connectClient(s);
    const extra = connectClient(s);
    expect(extra.refused?.code).toBe(4429);
    expect(control.sent).toHaveLength(3);
  });

  it('releases the pending slot when asking the agent to dial fails', () => {
    const s = setup({ maxPending: 1 });
    const control = withAgent(s);
    control.send = () => {
      throw new Error('socket closing');
    };
    const refused = connectClient(s);
    expect(refused.refused?.code).toBe(4503);
    expect(s.timers.every((t) => t.cancelled)).toBe(true);
    control.send = FakePeer.prototype.send.bind(control);
    expect(connectClient(s).refused).toBeNull();
  });

  it('closes both sides of a pair on a frame over the size cap', () => {
    const s = setup({ maxFrameBytes: 4 });
    const { client, agent } = pair(s);
    s.relay.message(client, Uint8Array.of(1, 2, 3, 4), true);
    expect(agent.sent).toHaveLength(1);
    s.relay.message(client, Uint8Array.of(1, 2, 3, 4, 5), true);
    expect(agent.sent).toHaveLength(1);
    expect(client.closedWith?.code).toBe(1009);
    expect(agent.closedWith?.code).toBe(1009);
  });

  it('measures a text frame in bytes, not characters', () => {
    const s = setup({ maxFrameBytes: 4 });
    const { client, agent } = pair(s);
    s.relay.message(client, 'éé€', false);
    expect(agent.sent).toHaveLength(0);
    expect(client.closedWith?.code).toBe(1009);
  });

  it('applies the caps it was given by default', () => {
    const s = setup();
    const control = withAgent(s);
    for (let i = 0; i < 8; i++) connectClient(s);
    expect(connectClient(s).refused?.code).toBe(4429);
    expect(control.sent).toHaveLength(8);
  });
});

describe('Relay device gate', () => {
  const publish = (s: Setup, control: FakePeer, policy: object) =>
    s.relay.message(control, JSON.stringify({ type: 'policy', devices: [], revoked: [], enrol: true, ...policy }), false);

  it('refuses a client without a device key once a policy is published, whatever an older agent says of anonymous clients', () => {
    const s = setup();
    const control = withAgent(s);
    publish(s, control, { anonymous: true });
    expect(connectClient(s).refused).toEqual({ code: 4401, reason: REFUSAL.deviceKeyRequired });
  });

  it('still admits a client without a device key from an agent that never published a policy', () => {
    const s = setup();
    withAgent(s);
    expect(connectClient(s).refused).toBeNull();
  });

  // Each enrolment dial makes the agent read its roster and pairing files and derive keys, so a
  // stranger's garbage proofs are capped per account; a phone pairing sends one.
  it('caps the enrolment dials of one account per minute, and refuses the rest in band with 429', async () => {
    let now = 1_000_000;
    const s = setup({ maxEnrolments: 2 });
    const relay = new Relay({ ...s.deps, now: () => now });
    const control = s.upgrade();
    relay.handle({ role: 'agent', account: 'acct' }, control);
    relay.message(control.peer!, JSON.stringify({ type: 'policy', devices: [], revoked: [], enrol: true }), false);
    const enrolling = async () => {
      const { ed25519 } = generateDeviceKeys();
      const nonce = relay.challenge('acct')!;
      const claim = { account: 'acct', nonce, device: ed25519.publicKey };
      const up = s.upgrade();
      relay.handle(
        {
          role: 'client',
          account: 'acct',
          device: { key: ed25519.publicKey, nonce, sig: await signDeviceAuth(ed25519Signer(ed25519.privateKey), claim), proof: enrolProof(enrolKey('t', 'acct'), claim) },
        },
        up,
      );
      const sent = control.peer!.sent.length;
      await until(() => up.refused || control.peer!.sent.length > sent);
      if (up.refused) return up;
      // The agent refuses each one, so the pending cap never stands in for this one.
      const dial = JSON.parse(control.peer!.sent.at(-1)!.data as string) as { id: string };
      relay.message(control.peer!, JSON.stringify({ type: 'refuse', id: dial.id }), false);
      return up;
    };
    expect((await enrolling()).refused?.code).toBe(4403);
    expect((await enrolling()).refused?.code).toBe(4403);
    const dials = control.peer!.sent.length;
    expect((await enrolling()).refused).toEqual({ code: 4429, reason: REFUSAL.tooManyEnrolments });
    expect(control.peer!.sent.length).toBe(dials);
    now += 60_000;
    expect((await enrolling()).refused?.code).toBe(4403);
  });

  // A Durable Object is rebuilt whenever it wakes from hibernation: the budget lives in its store,
  // or every eviction would hand a stranger a fresh one.
  it('keeps the enrolment budget in the store, so a relay rebuilt over it does not start afresh', async () => {
    const now = 1_000_000;
    const s = setup({ maxEnrolments: 2 });
    const store = new MemoryStore();
    let writes = 0;
    const put = store.put.bind(store);
    store.put = (key, value) => {
      if (key === 'enrolments') writes += 1;
      put(key, value);
    };
    const build = () => {
      const relay = new Relay({ ...s.deps, store, now: () => now });
      const control = s.upgrade();
      relay.handle({ role: 'agent', account: 'acct' }, control);
      relay.message(control.peer!, JSON.stringify({ type: 'policy', devices: [], revoked: [], enrol: true }), false);
      return { relay, control: control.peer! };
    };
    const enrolling = async ({ relay, control }: ReturnType<typeof build>) => {
      const { ed25519 } = generateDeviceKeys();
      const nonce = relay.challenge('acct')!;
      const claim = { account: 'acct', nonce, device: ed25519.publicKey };
      const up = s.upgrade();
      relay.handle(
        {
          role: 'client',
          account: 'acct',
          device: { key: ed25519.publicKey, nonce, sig: await signDeviceAuth(ed25519Signer(ed25519.privateKey), claim), proof: enrolProof(enrolKey('t', 'acct'), claim) },
        },
        up,
      );
      const sent = control.sent.length;
      await until(() => up.refused || control.sent.length > sent);
      if (up.refused) return up;
      const dial = JSON.parse(control.sent.at(-1)!.data as string) as { id: string };
      relay.message(control, JSON.stringify({ type: 'refuse', id: dial.id }), false);
      return up;
    };
    expect((await enrolling(build())).refused?.code).toBe(4403);
    expect((await enrolling(build())).refused?.code).toBe(4403);
    expect((await enrolling(build())).refused?.code).toBe(4429);
    expect((await enrolling(build())).refused?.code).toBe(4429);
    // Refused attempts write nothing: a flood costs the store no writes.
    expect(writes).toBe(2);
  });
});

describe('Relay in-band gate', () => {
  const enrolled = generateDeviceKeys().ed25519;

  function gated(limits: Limits & { gateTimeoutMs?: number } = {}) {
    const s = setup(limits);
    const control = withAgent(s);
    s.relay.message(control, JSON.stringify({ type: 'policy', devices: [enrolled.publicKey], revoked: [], enrol: true }), false);
    control.sent.length = 0;
    return { ...s, control };
  }

  function open(s: Setup): FakeUpgrade {
    const up = s.upgrade();
    s.relay.handle({ role: 'client', account: 'acct', inBand: true }, up);
    return up;
  }

  const nonceOf = (peer: FakePeer) => parseGateChallenge(String(peer.sent[0]!.data))!;

  async function answer(s: Setup, peer: FakePeer, options: { nonce?: string; key?: typeof enrolled; signer?: typeof enrolled } = {}) {
    const key = options.key ?? enrolled;
    const nonce = options.nonce ?? nonceOf(peer);
    const signer = options.signer ?? key;
    const sig = await signDeviceAuth(ed25519Signer(signer.privateKey), { account: 'acct', nonce, device: key.publicKey });
    s.relay.message(peer, encodeGateReply({ key: key.publicKey, nonce, sig }), false);
  }

  it('accepts the upgrade at once, files it as a gate and sends only a challenge', () => {
    const s = gated();
    const up = open(s);
    expect(up.label).toEqual({ kind: 'gate' });
    expect(up.peer!.sent).toHaveLength(1);
    expect(nonceOf(up.peer!)).toMatch(/^[\w-]+$/);
    expect(s.control.sent).toEqual([]);
    expect(s.directory.count('client')).toBe(0);
  });

  it('pairs an enrolled device with a spare once it answers, and says ready before any frame', async () => {
    const s = gated();
    const filed = spare(s, 's1');
    const up = open(s);
    await answer(s, up.peer!);
    await until(() => up.peer!.sent.length > 1);
    expect(up.peer!.sent[1]).toEqual({ data: GATE_READY, binary: false });
    expect(s.directory.labelOf(up.peer!)).toEqual({ kind: 'client', pair: 'spare.s1' });
    expect(filed.peer!.sent).toEqual([{ data: 'paired', binary: false }]);
    const bytes = Uint8Array.of(1, 2, 3);
    s.relay.message(up.peer!, bytes, true);
    expect(filed.peer!.sent.at(-1)).toEqual({ data: bytes, binary: true });
  });

  it('asks the agent to dial when there is no spare, and says ready once it has', async () => {
    const s = gated();
    const up = open(s);
    await answer(s, up.peer!);
    await until(() => s.control.sent.length > 0);
    expect(up.peer!.sent).toHaveLength(1);
    const { id } = JSON.parse(String(s.control.sent[0]!.data)) as { id: string };
    const agent = dial(s, id);
    expect(up.peer!.sent[1]).toEqual({ data: GATE_READY, binary: false });
    expect(s.directory.labelOf(up.peer!)).toEqual({ kind: 'client', pair: id });
    s.relay.message(agent.peer!, Uint8Array.of(9), true);
    expect(up.peer!.sent.at(-1)).toEqual({ data: Uint8Array.of(9), binary: true });
  });

  it('refuses in band with the same reasons: a bad signature, a reused nonce, an unknown key', async () => {
    const s = gated();
    const first = open(s);
    const nonce = nonceOf(first.peer!);
    await answer(s, first.peer!, { signer: generateDeviceKeys().ed25519, nonce });
    await until(() => first.peer!.closedWith);
    expect(first.peer!.closedWith).toEqual({ code: 4401, reason: REFUSAL.signature });
    const second = open(s);
    await answer(s, second.peer!, { nonce });
    await until(() => second.peer!.closedWith);
    expect(second.peer!.closedWith).toEqual({ code: 4401, reason: REFUSAL.challenge });
    const third = open(s);
    await answer(s, third.peer!, { key: generateDeviceKeys().ed25519 });
    await until(() => third.peer!.closedWith);
    expect(third.peer!.closedWith).toEqual({ code: 4403, reason: REFUSAL.notEnrolled });
    expect(s.control.sent).toEqual([]);
  });

  it('closes a gate on anything but one well-formed text reply, forwarding nothing', async () => {
    const s = gated();
    spare(s, 's1');
    const replies: Array<[RelayData, boolean]> = [
      [Uint8Array.of(1), true],
      ['x'.repeat(MAX_GATE_REPLY_BYTES + 1), false],
      ['{"type":"device"}', false],
    ];
    for (const [data, binary] of replies) {
      const up = open(s);
      s.relay.message(up.peer!, data, binary);
      expect(up.peer!.closedWith).toEqual({ code: 4400, reason: REFUSAL.invalidReply });
    }
    const up = open(s);
    await answer(s, up.peer!, { key: generateDeviceKeys().ed25519 });
    s.relay.message(up.peer!, Uint8Array.of(1), true);
    expect(up.peer!.closedWith).toEqual({ code: 4400, reason: REFUSAL.invalidReply });
    expect(s.directory.count('client')).toBe(0);
  });

  it('closes a gate that does not answer in time', () => {
    const s = gated({ gateTimeoutMs: 1234 });
    const up = open(s);
    const timer = s.timers.at(-1)!;
    expect(timer.ms).toBe(1234);
    timer.fn();
    expect(up.peer!.closedWith).toEqual({ code: 4408, reason: REFUSAL.challengeUnanswered });
  });

  it('closes the oldest gate still waiting for its answer, never the newcomer, at the cap', async () => {
    const s = gated();
    const answered = open(s);
    await answer(s, answered.peer!);
    await until(() => s.control.sent.length > 0);
    const waiting = Array.from({ length: 8 }, () => open(s));
    expect(waiting.every((up) => up.peer!.closedWith === null)).toBe(true);
    const late = open(s);
    expect(waiting[0]!.peer!.closedWith).toEqual({ code: 4429, reason: REFUSAL.tooManyPending });
    expect(waiting.slice(1).every((up) => up.peer!.closedWith === null)).toBe(true);
    expect(late.peer!.sent).toHaveLength(1);
    expect(answered.peer!.closedWith).toBeNull();
  });

  it('drops the pending dial of a gate that hangs up, and refuses that dial', async () => {
    const s = gated();
    const up = open(s);
    await answer(s, up.peer!);
    await until(() => s.control.sent.length > 0);
    const { id } = JSON.parse(String(s.control.sent[0]!.data)) as { id: string };
    s.drop(up.peer!, 1001);
    expect(dial(s, id).rejected?.status).toBe(404);
  });

  it('closes a gate it has no record of, as after its relay was rebuilt', () => {
    const s = gated();
    const up = open(s);
    const rebuilt = new Relay(s.deps);
    rebuilt.message(up.peer!, '{}', false);
    expect(up.peer!.closedWith).toEqual({ code: 4401, reason: REFUSAL.challenge });
  });

  it('refuses a removed account in band before opening a gate', () => {
    const s = gated();
    s.relay.evict();
    const up = open(s);
    expect(up.refused).toEqual({ code: 4404, reason: REFUSAL.unknownAccount });
  });
});
