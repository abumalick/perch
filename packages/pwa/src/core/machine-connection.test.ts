import { describe, it, expect } from 'vitest';
import { MachineConnection, type ConnectionDiagnostic } from './machine-connection';
import type { CloseInfo, Socket } from './ports/socket';
import type { AgentMessage } from '@perch/contracts';
import type { RefusalContext } from './refusal';

function fakeSocket() {
  const sent: string[] = [];
  let onMessage: (d: string) => void = () => undefined;
  let onOpen: () => void = () => undefined;
  let onClose: (info?: CloseInfo) => void = () => undefined;
  let onError: () => void = () => undefined;
  let closed = false;
  const socket: Socket = {
    send: (d) => sent.push(d),
    close: () => {
      closed = true;
    },
    onMessage: (cb) => {
      onMessage = cb;
    },
    onOpen: (cb) => {
      onOpen = cb;
    },
    onClose: (cb) => {
      onClose = cb;
    },
    onError: (cb) => {
      onError = cb;
    },
  };
  return {
    socket,
    sent,
    isClosed: () => closed,
    open: () => onOpen(),
    deliver: (m: unknown) => onMessage(JSON.stringify(m)),
    fireClose: (info?: CloseInfo) => onClose(info),
    fireError: () => onError(),
  };
}

function harness(refusalContext?: RefusalContext) {
  const spent: string[] = [];
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const messages: AgentMessage[] = [];
  const statuses: string[] = [];
  const diagnostics: ConnectionDiagnostic[] = [];
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const conn = new MachineConnection({
    url: 'wss://m1.ts.net',
    token: 'secret',
    socketFactory: () => {
      const f = fakeSocket();
      sockets.push(f);
      return f.socket;
    },
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    onDiagnostic: (d) => diagnostics.push(d),
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
    startTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    now: () => 1000,
    refusalContext,
    onCredentialsSpent: (scope) => spent.push(scope),
  });
  return { conn, sockets, messages, statuses, diagnostics, scheduled, timers, spent };
}

const authOf = (socket: ReturnType<typeof fakeSocket>) => socket.sent.map((d) => JSON.parse(d) as { type: string; token?: string }).find((m) => m.type === 'auth');

// Once the device key is enrolled the token and the pairing secret are dead weight, and sending
// them on every connect hands them to whoever holds the agent's relay key.
describe('MachineConnection credentials', () => {
  const tokened: RefusalContext = { machine: 'dev box', credential: 'token' };

  it('forgets its credential once the agent says the device key is enrolled', () => {
    const h = harness(tokened);
    h.conn.connect();
    h.sockets[0]!.open();
    expect(authOf(h.sockets[0]!)).toEqual({ type: 'auth', token: 'secret' });
    h.sockets[0]!.deliver({ type: 'authResult', ok: true, credential: 'token', enrolled: true });
    expect(h.spent).toEqual(['all']);
    h.sockets[0]!.fireClose({ code: 1006 });
    h.scheduled[0]!.fn();
    h.sockets[1]!.open();
    expect(authOf(h.sockets[1]!)).toEqual({ type: 'auth', token: '' });
  });

  it('keeps its credential when the key is not enrolled, or the agent does not say', () => {
    const h = harness(tokened);
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true, enrolled: false });
    h.sockets[0]!.fireClose({ code: 1006 });
    h.scheduled[0]!.fn();
    h.sockets[1]!.open();
    h.sockets[1]!.deliver({ type: 'authResult', ok: true });
    expect(h.spent).toEqual([]);
    expect(authOf(h.sockets[1]!)).toEqual({ type: 'auth', token: 'secret' });
  });

  // The close reason travels outside the session, so the relay can forge it: the token is only
  // held back for the next attempt, and forgotten for good once the agent itself says, inside
  // the session, that the key is enrolled.
  it('redials without the token when it is refused as not needed, and forgets it once enrolment is confirmed', () => {
    const h = harness(tokened);
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.fireClose({ code: 4003, reason: 'token not needed' });
    expect(h.spent).toEqual([]);
    expect(h.diagnostics[0]).toMatchObject({ refused: true });
    expect(h.scheduled).toHaveLength(1);
    h.scheduled[0]!.fn();
    h.sockets[1]!.open();
    expect(authOf(h.sockets[1]!)).toEqual({ type: 'auth', token: '' });
    h.sockets[1]!.deliver({ type: 'authResult', ok: true, credential: 'device', enrolled: true });
    expect(h.spent).toEqual(['all']);
  });

  it('sends the token again when the attempt without it is refused as not enrolled', () => {
    const h = harness(tokened);
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.fireClose({ code: 4003, reason: 'token not needed' });
    h.scheduled[0]!.fn();
    h.sockets[1]!.open();
    h.sockets[1]!.fireClose({ code: 4003, reason: 'device not enrolled' });
    expect(h.spent).toEqual([]);
    expect(h.scheduled).toHaveLength(2);
    h.scheduled[1]!.fn();
    h.sockets[2]!.open();
    expect(authOf(h.sockets[2]!)).toEqual({ type: 'auth', token: 'secret' });
  });

  // An agent from before `enrolled` still spends a pairing secret on `auth`.
  it('drops only the pairing secret when an agent does not say whether the key is enrolled', () => {
    const h = harness({ machine: 'dev box', credential: 'pairing' });
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true });
    expect(h.spent).toEqual(['pairing']);
  });

  it('keeps a pairing secret the agent could not enrol, so the phone can retry with it', () => {
    const h = harness({ machine: 'dev box', credential: 'pairing' });
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true, credential: 'pairing', enrolled: false });
    expect(h.spent).toEqual([]);
  });
});

describe('MachineConnection refusals', () => {
  const paired: RefusalContext = { machine: 'dev box', credential: 'pairing' };

  it('says what the relay refused, without the code, and waits for the owner instead of redialing', () => {
    const h = harness(paired);
    h.conn.connect();
    h.sockets[0]!.fireClose({ code: 4403, reason: 'pairing code expired' });
    expect(h.diagnostics).toEqual([
      { message: 'This pairing code has expired — run `perch pair` on dev box for a new one', code: 4403, at: 1000, refused: true, final: true },
    ]);
    expect(h.statuses.at(-1)).toBe('offline');
    expect(h.scheduled).toEqual([]);
  });

  it('says what the agent refused once the session was open, too', () => {
    const h = harness(paired);
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.fireClose({ code: 4003, reason: 'pairing code used' });
    expect(h.diagnostics[0]).toMatchObject({ message: expect.stringMatching(/^This pairing code was already used/), refused: true });
    expect(h.scheduled).toEqual([]);
  });

  it('keeps redialing through a refusal that can pass', () => {
    const h = harness(paired);
    h.conn.connect();
    h.sockets[0]!.fireClose({ code: 4503, reason: 'agent offline' });
    expect(h.diagnostics[0]).toMatchObject({ message: 'dev box is not connected to the relay', refused: true });
    expect(h.scheduled).toHaveLength(1);
  });

  it('tries again when the owner asks, after a final refusal', () => {
    const h = harness(paired);
    h.conn.connect();
    h.sockets[0]!.fireClose({ code: 4403, reason: 'device revoked' });
    h.conn.reconnect();
    expect(h.sockets).toHaveLength(2);
    expect(h.statuses.at(-1)).toBe('connecting');
  });

  it.each(['relay challenge timed out', 'relay challenge failed: network error'])('reads nothing into a challenge that could not be had (%s), and redials', (reason) => {
    const h = harness(paired);
    h.conn.connect();
    h.sockets[0]!.fireClose({ code: undefined, reason });
    expect(h.diagnostics[0]).toMatchObject({ message: `connection failed (${reason})` });
    expect(h.diagnostics[0]!.refused).toBeUndefined();
    expect(h.scheduled).toHaveLength(1);
  });

  it('reads nothing into a close outside the refusal codes', () => {
    const h = harness(paired);
    h.conn.connect();
    h.sockets[0]!.fireClose({ code: 1006 });
    expect(h.diagnostics[0]!.refused).toBeUndefined();
    expect(h.scheduled).toHaveLength(1);
  });
});

describe('MachineConnection', () => {
  it('authenticates on open and reaches online', () => {
    const h = harness();
    h.conn.connect();
    expect(h.statuses).toContain('connecting');
    const s0 = h.sockets[0]!;
    s0.open();
    expect(JSON.parse(s0.sent[0]!)).toEqual({ type: 'auth', token: 'secret' });
    s0.deliver({ type: 'authResult', ok: true });
    expect(h.statuses).toContain('online');
  });

  it('forwards non-auth agent messages', () => {
    const h = harness();
    h.conn.connect();
    const s0 = h.sockets[0]!;
    s0.open();
    s0.deliver({ type: 'authResult', ok: true });
    s0.deliver({ type: 'workspaces', workspaces: [] });
    expect(h.messages).toContainEqual({ type: 'workspaces', workspaces: [] });
  });

  it('ignores malformed frames without throwing', () => {
    const h = harness();
    h.conn.connect();
    const s0 = h.sockets[0]!;
    s0.open();
    s0.deliver({ type: 'authResult', ok: true });
    expect(() => s0.deliver({ type: 'nonsense' })).not.toThrow();
    expect(h.messages).toEqual([]);
  });

  it('drops an outdated agent\'s legacy-shape workspace message without crashing', () => {
    // After the status flattening, an old agent still sends attention/blocked and no status.
    // The strict parser rejects it; handle() must swallow the throw and forward nothing
    // (the machine just shows no workspaces) rather than take the PWA down.
    const h = harness();
    h.conn.connect();
    const s0 = h.sockets[0]!;
    s0.open();
    s0.deliver({ type: 'authResult', ok: true });
    const legacy = {
      machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude',
      createdAt: 0, lastActivityAt: 0, attention: 'needs-feedback', blocked: false,
    };
    expect(() => s0.deliver({ type: 'workspaces', workspaces: [legacy] })).not.toThrow();
    expect(h.messages).toEqual([]);
  });

  it('schedules a backoff reconnect on close', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true });
    h.sockets[0]!.fireClose();
    expect(h.statuses).toContain('offline');
    expect(h.scheduled[0]?.ms).toBe(250);
    h.scheduled[0]!.fn(); // run the reconnect
    expect(h.sockets).toHaveLength(2); // a new socket was created
  });

  it('does not reconnect after an auth rejection', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: false });
    expect(h.sockets[0]!.isClosed()).toBe(true);
    h.sockets[0]!.fireClose();
    expect(h.scheduled).toHaveLength(0);
  });

  it('sends client messages as JSON when connected', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true });
    h.conn.send({ type: 'list' });
    expect(JSON.parse(h.sockets[0]!.sent.at(-1)!)).toEqual({ type: 'list' });
  });

  it('doubles backoff between the bounded retry attempts', () => {
    const h = harness();
    h.conn.connect(); // attempt 1
    h.sockets[0]!.fireClose({ code: 1006 });
    h.scheduled[0]!.fn(); // attempt 2
    h.sockets[1]!.fireClose({ code: 1006 });
    expect(h.scheduled.map((s) => s.ms)).toEqual([250, 500]);
  });

  it('gives up after the attempt budget is exhausted and stops churning', () => {
    const h = harness();
    h.conn.connect(); // attempt 1
    h.sockets[0]!.fireClose({ code: 1006 });
    h.scheduled[0]!.fn(); // attempt 2
    h.sockets[1]!.fireClose({ code: 1006 });
    h.scheduled[1]!.fn(); // attempt 3
    h.sockets[2]!.fireClose({ code: 1006 });
    h.scheduled[2]!.fn(); // attempt 4
    h.sockets[3]!.fireClose({ code: 1006 });

    // Budget (4) exhausted: no further reconnect is scheduled — the dead machine
    // goes quiet instead of hammering the network.
    expect(h.sockets).toHaveLength(4);
    expect(h.scheduled.map((s) => s.ms)).toEqual([250, 500, 1000]);
    expect(h.statuses.at(-1)).toBe('offline');
  });

  it('reconnect() resumes a machine that gave up, with a fresh budget', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.fireClose({ code: 1006 });
    h.scheduled[0]!.fn();
    h.sockets[1]!.fireClose({ code: 1006 });
    h.scheduled[1]!.fn();
    h.sockets[2]!.fireClose({ code: 1006 });
    h.scheduled[2]!.fn();
    h.sockets[3]!.fireClose({ code: 1006 }); // gave up
    expect(h.sockets).toHaveLength(4);

    h.conn.reconnect();
    expect(h.sockets).toHaveLength(5); // a fresh attempt was made
    h.sockets[4]!.fireClose({ code: 1006 });
    expect(h.scheduled.at(-1)!.ms).toBe(250); // backoff reset to base
  });

  it('never gives up on a machine that has connected before (rides through drops)', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true }); // now known-reachable

    // Drop and fail to reconnect far past the give-up budget (e.g. a WiFi↔cellular switch).
    for (let i = 0; i < 7; i += 1) {
      h.sockets[i]!.fireClose({ code: 1006 });
      expect(h.scheduled[i]).toBeDefined(); // a retry is always scheduled — never gives up
      h.scheduled[i]!.fn(); // run the reconnect → next socket
    }
    expect(h.sockets).toHaveLength(8); // kept reconnecting; a never-connected machine stops at 4
  });

  it('reaching online resets the attempt budget', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.fireClose({ code: 1006 }); // fail 1
    h.scheduled[0]!.fn();
    h.sockets[1]!.fireClose({ code: 1006 }); // fail 2
    h.scheduled[1]!.fn();
    h.sockets[2]!.open();
    h.sockets[2]!.deliver({ type: 'authResult', ok: true }); // online -> budget resets
    h.sockets[2]!.fireClose({ code: 1006 }); // fail 1 again, not 3

    // Still retrying (budget was reset), and backoff restarted at base.
    expect(h.scheduled.at(-1)!.ms).toBe(250);
  });

  it('close() suppresses reconnect after socket closes', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true });
    h.conn.close();
    h.sockets[0]!.fireClose();
    expect(h.scheduled).toHaveLength(0);
  });

  it('reconnect() invalidates a pending backoff retry (no stacked connect chains)', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true });
    h.sockets[0]!.fireClose({ code: 1006 }); // schedules a backoff retry
    expect(h.scheduled).toHaveLength(1);

    h.conn.reconnect(); // starts a fresh chain — the pending retry is now stale
    expect(h.sockets).toHaveLength(2);
    h.scheduled[0]!.fn(); // the stale retry fires late — must be a no-op
    expect(h.sockets).toHaveLength(2); // NOT 3: no orphaned second chain
  });

  it('close() invalidates a pending backoff retry (fully quiesces)', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true });
    h.sockets[0]!.fireClose({ code: 1006 }); // schedules a backoff retry
    h.conn.close();
    h.scheduled[0]!.fn(); // the pending retry must not resurrect the connection
    expect(h.sockets).toHaveLength(1);
  });

  it('ignores a late open from a superseded socket (no auth on an orphan)', () => {
    const h = harness();
    h.conn.connect(); // socket 0
    h.conn.reconnect(); // socket 1 supersedes socket 0
    h.sockets[0]!.open(); // the orphaned socket opens late
    expect(h.sockets[0]!.sent).toHaveLength(0); // must not send auth
  });

  it('ignores messages from a superseded socket', () => {
    const h = harness();
    h.conn.connect(); // socket 0
    h.conn.reconnect(); // socket 1 supersedes socket 0
    h.sockets[0]!.deliver({ type: 'authResult', ok: true }); // orphan tries to authenticate
    expect(h.statuses).not.toContain('online'); // the orphan can't drive us online
  });

  it('labels a 1006 close before open as a likely block', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.fireClose({ code: 1006 });
    expect(h.diagnostics).toEqual([
      { message: 'connection failed (likely network error — relay unreachable)', code: 1006, at: 1000, attempt: 1, retryInMs: 250 },
    ]);
  });

  it('labels a close after an error event as a likely block', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.fireError();
    h.sockets[0]!.fireClose();
    expect(h.diagnostics[0]!.message).toBe('connection failed (likely network error — relay unreachable)');
  });

  it('reports the reason a socket gives for closing before it opened', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.fireClose({ code: 4002, reason: 'agent key mismatch' });
    expect(h.diagnostics[0]!.message).toBe('connection failed (agent key mismatch)');
  });

  it('distinguishes opened-then-dropped from never-opened', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true });
    h.sockets[0]!.fireClose({ code: 1001, reason: 'going away' });
    expect(h.diagnostics[0]!.message).toBe('closed by agent — going away');
    expect(h.diagnostics[0]!.code).toBe(1001);
  });

  it('numbers each failed attempt and says when the next one is due', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.fireClose({ code: 1006 });
    h.scheduled[0]!.fn();
    h.sockets[1]!.fireClose({ code: 1006 });
    expect(h.diagnostics.map((d) => [d.attempt, d.retryInMs])).toEqual([
      [1, 250],
      [2, 500],
    ]);
  });

  it('resetBackoff() retries the in-flight attempt soon if it fails, without aborting it', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true });
    for (let i = 0; i < 6; i += 1) {
      h.sockets[i]!.fireClose({ code: 1006 });
      h.scheduled[i]!.fn();
    }
    expect(h.diagnostics.at(-1)!.retryInMs).toBe(8000);
    h.conn.resetBackoff();
    expect(h.sockets[6]!.isClosed()).toBe(false);
    h.sockets[6]!.fireClose({ code: 1006 });
    expect(h.diagnostics.at(-1)).toMatchObject({ attempt: 7, retryInMs: 250 });
  });

  it('says no retry is due once a never-connected machine gives up', () => {
    const h = harness();
    h.conn.connect();
    for (let i = 0; i < 4; i += 1) {
      h.sockets[i]!.fireClose({ code: 1006 });
      h.scheduled[i]?.fn();
    }
    expect(h.diagnostics.at(-1)).toMatchObject({ attempt: 4 });
    expect(h.diagnostics.at(-1)!.retryInMs).toBeUndefined();
  });

  it('reports an auth rejection diagnostic', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: false });
    expect(h.diagnostics).toEqual([{ message: 'auth rejected', at: 1000 }]);
  });

  it('reaps a connection stalled in "connecting" after the connect timeout and retries', () => {
    const h = harness();
    h.conn.connect();
    expect(h.statuses).toEqual(['connecting']);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(10000);

    h.timers[0]!.fn(); // deadline fires; the socket never opened
    expect(h.sockets[0]!.isClosed()).toBe(true);

    h.sockets[0]!.fireClose({ code: 1006 }); // the browser emits close after close()
    expect(h.statuses).toContain('offline');
    expect(h.diagnostics.at(-1)!.message).toBe('connection timed out');
    expect(h.scheduled[0]?.ms).toBe(250); // a backoff reconnect is scheduled

    h.scheduled[0]!.fn();
    expect(h.sockets).toHaveLength(2); // it reconnected on its own
  });

  it('pings after reaching online', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true });
    h.timers.at(-1)!.fn(); // heartbeat interval elapses → a ping is sent
    expect(JSON.parse(h.sockets[0]!.sent.at(-1)!)).toEqual({ type: 'ping' });
  });

  it('closes a half-open socket whose ping goes unanswered', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true });
    h.timers.at(-1)!.fn(); // ping sent, pong deadline armed
    h.timers.at(-1)!.fn(); // deadline elapses with no reply → force close
    expect(h.sockets[0]!.isClosed()).toBe(true);
  });

  it('stays alive and keeps pinging when the ping is answered', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true });
    h.timers.at(-1)!.fn(); // ping sent, pong deadline armed
    h.sockets[0]!.deliver({ type: 'pong' });
    const before = h.timers.length;
    h.timers.at(-1)!.fn(); // deadline elapses, but a reply arrived → healthy
    expect(h.sockets[0]!.isClosed()).toBe(false);
    expect(h.timers.length).toBe(before + 1); // the next ping is armed
  });

  it('does not forward pong replies to the message sink', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true });
    h.sockets[0]!.deliver({ type: 'pong' });
    expect(h.messages).toEqual([]);
  });

  it('checkLiveness pings immediately and closes if unanswered', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true });
    h.conn.checkLiveness();
    expect(JSON.parse(h.sockets[0]!.sent.at(-1)!)).toEqual({ type: 'ping' });
    h.timers.at(-1)!.fn(); // pong deadline elapses with no reply → force close
    expect(h.sockets[0]!.isClosed()).toBe(true);
  });

  it('checkLiveness is a no-op when offline', () => {
    const h = harness();
    h.conn.connect(); // connecting, never authed
    expect(() => h.conn.checkLiveness()).not.toThrow();
    expect(h.sockets[0]!.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(false);
  });

  it('stops the heartbeat once the socket closes', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({ type: 'authResult', ok: true });
    const pingTimer = h.timers.at(-1)!;
    h.conn.close();
    pingTimer.fn(); // a racing heartbeat timer must not ping a closed socket
    expect(h.sockets[0]!.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(false);
  });

  it('cancels the connect deadline once the socket opens, sparing a healthy connection', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    expect(h.timers[0]!.cancelled).toBe(true);

    h.timers[0]!.fn(); // a late/cancelled deadline must not disturb an open socket
    expect(h.sockets[0]!.isClosed()).toBe(false);
  });
});

describe('MachineConnection authResult channels', () => {
  it('goes online whether or not the agent lists its side channels', () => {
    const events: string[] = [];
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const conn = new MachineConnection({
      url: 'wss://m1',
      token: 't',
      socketFactory: () => {
        const f = fakeSocket();
        sockets.push(f);
        return f.socket;
      },
      onMessage: () => undefined,
      onStatus: (s) => events.push(s),
      schedule: () => undefined,
      startTimer: () => () => undefined,
    });
    conn.connect();
    sockets[0]!.open();
    sockets[0]!.deliver({ type: 'authResult', ok: true, channels: ['media', 'clientLog'] });
    conn.reconnect();
    sockets[1]!.open();
    sockets[1]!.deliver({ type: 'authResult', ok: true });
    expect(events).toEqual(['connecting', 'online', 'connecting', 'online']);
  });
});

// An agent that served the phone at once (`pushed`) already sent what the phone asks for on every
// connect; any other agent is asked, right after its authResult and before `online`.
describe('MachineConnection opening requests', () => {
  function opening() {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const events: string[] = [];
    const conn = new MachineConnection({
      url: 'wss://m1',
      token: '',
      socketFactory: () => {
        const f = fakeSocket();
        sockets.push(f);
        f.socket.send = (d) => void (f.sent.push(d), events.push(`sent ${(JSON.parse(d) as { type: string }).type}`));
        return f.socket;
      },
      onMessage: (m) => events.push(`message ${m.type}`),
      onStatus: (s) => events.push(s),
      schedule: () => undefined,
      startTimer: () => () => undefined,
      openingRequests: [{ type: 'list' }, { type: 'listCommands' }],
    });
    conn.connect();
    sockets[0]!.open();
    return { sockets, events };
  }

  it('asks for them after an authResult that did not bring them, then goes online', () => {
    const { sockets, events } = opening();
    sockets[0]!.deliver({ type: 'authResult', ok: true, credential: 'device', enrolled: true });
    expect(events).toEqual(['connecting', 'sent auth', 'sent list', 'sent listCommands', 'online']);
  });

  it('asks for nothing when the agent pushed them, and still sends its auth', () => {
    const { sockets, events } = opening();
    sockets[0]!.deliver({ type: 'authResult', ok: true, credential: 'device', enrolled: true, pushed: true });
    sockets[0]!.deliver({ type: 'workspaces', workspaces: [] });
    expect(events).toEqual(['connecting', 'sent auth', 'online', 'message workspaces']);
  });
});
