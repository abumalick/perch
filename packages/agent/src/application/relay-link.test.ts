import { describe, it, expect } from 'vitest';
import type { EnrolmentVerdict } from '../ports/device-gate-port';
import { RelayLink } from './relay-link';
import type { RelayControl, RelayTransport } from '../ports/relay-port';
import type { RelayPolicy } from '@perch/secure-channel';

class FakeControl implements RelayControl {
  closed = false;
  sent: string[] = [];
  private open: Array<() => void> = [];
  private message: Array<(text: string) => void> = [];
  private close_: Array<(code: number) => void> = [];
  onOpen(l: () => void): void {
    this.open.push(l);
  }
  onMessage(l: (text: string) => void): void {
    this.message.push(l);
  }
  onClose(l: (code: number) => void): void {
    this.close_.push(l);
  }
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.closed = true;
    this.drop(1006);
  }
  opened(): void {
    this.open.forEach((l) => l());
  }
  receive(text: string): void {
    this.message.forEach((l) => l(text));
  }
  drop(code = 1006): void {
    this.close_.forEach((l) => l(code));
  }
}

interface Extra {
  policy?: () => Promise<RelayPolicy>;
  admitEnrolment?: (enrol: { device: string; nonce: string; proof: string }) => Promise<EnrolmentVerdict>;
}

function setup(
  dialResult: (url: string) => Promise<string> = (url) => Promise.resolve(`socket:${url}`),
  extra: Extra = {},
) {
  const controls: FakeControl[] = [];
  const controlUrls: string[] = [];
  const controlHeaders: Array<Record<string, string>> = [];
  const dials: string[] = [];
  const dialHeaders: Array<Record<string, string>> = [];
  const sockets: string[] = [];
  const releases: Array<() => void> = [];
  const logs: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const clock = { now: 0 };
  const transport: RelayTransport<string> = {
    openControl: (url, headers) => {
      controlUrls.push(url);
      controlHeaders.push(headers);
      const control = new FakeControl();
      controls.push(control);
      return control;
    },
    dial: (url, headers) => {
      dials.push(url);
      dialHeaders.push(headers);
      return dialResult(url);
    },
  };
  const link = new RelayLink({
    url: 'wss://relay.example.com/',
    account: 'acct',
    authHeaders: (role, dialId) => ({ authorization: `signed:${role}:${dialId ?? '-'}` }),
    heartbeatMs: 20_000,
    transport,
    onSocket: (s, release) => {
      sockets.push(s);
      releases.push(release);
    },
    startTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    log: (m) => logs.push(m),
    now: () => clock.now,
    ...extra,
  });
  const fireNext = () => {
    const timer = timers.find((t) => !t.cancelled);
    if (!timer) throw new Error('no timer armed');
    timer.cancelled = true;
    timer.fn();
    return timer.ms;
  };
  return { link, controls, controlUrls, controlHeaders, dials, dialHeaders, sockets, releases, logs, timers, fireNext, clock };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('RelayLink', () => {
  it('opens the control socket with the agent role on the account URL, signed', () => {
    const { link, controlUrls, controlHeaders } = setup();
    link.start();
    expect(controlUrls).toEqual(['wss://relay.example.com/acct?role=agent']);
    expect(controlHeaders).toEqual([{ authorization: 'signed:agent:-' }]);
  });

  it('dials a fresh signed socket for each dial request, the id in a header, and hands it over', async () => {
    const { link, controls, dials, dialHeaders, sockets } = setup();
    link.start();
    controls[0]!.opened();
    controls[0]!.receive(JSON.stringify({ type: 'dial', id: 'a1' }));
    controls[0]!.receive(JSON.stringify({ type: 'dial', id: 'b2' }));
    await flush();
    expect(dials).toEqual(['wss://relay.example.com/acct?role=dial', 'wss://relay.example.com/acct?role=dial']);
    expect(dialHeaders).toEqual([
      { authorization: 'signed:dial:a1', 'x-perch-dial': 'a1' },
      { authorization: 'signed:dial:b2', 'x-perch-dial': 'b2' },
    ]);
    expect(sockets).toHaveLength(2);
  });

  // A hostile relay can ask for dial-backs faster than they complete, and complete each one at
  // once; each is a socket and a pending handshake on the agent's side until it authenticates.
  it('keeps at most 32 dial-backs unauthenticated, and dials again once one is released', async () => {
    const { link, controls, dials, releases, logs } = setup();
    link.start();
    controls[0]!.opened();
    for (let i = 0; i < 40; i++) {
      controls[0]!.receive(JSON.stringify({ type: 'dial', id: `d${i}` }));
      await flush();
    }
    expect(dials).toHaveLength(32);
    expect(logs.filter((l) => l.includes('unauthenticated dial-backs'))).toHaveLength(1);
    releases[0]!();
    releases[0]!();
    controls[0]!.receive(JSON.stringify({ type: 'dial', id: 'late' }));
    controls[0]!.receive(JSON.stringify({ type: 'dial', id: 'later' }));
    expect(dials).toHaveLength(33);
  });

  it('frees the slot of a dial that failed', async () => {
    const { link, controls, dials } = setup(() => Promise.reject(new Error('refused')));
    link.start();
    controls[0]!.opened();
    for (let i = 0; i < 40; i++) {
      controls[0]!.receive(JSON.stringify({ type: 'dial', id: `d${i}` }));
      await flush();
    }
    expect(dials).toHaveLength(40);
  });

  it('refuses a dial id the relay could use to forge a log line', () => {
    const { link, controls, dials } = setup();
    link.start();
    controls[0]!.opened();
    controls[0]!.receive(JSON.stringify({ type: 'dial', id: 'x\nrelay client: device 1234 enrolled' }));
    expect(dials).toEqual([]);
  });

  it('sends a heartbeat on the control socket while it is open, and stops once it closes', () => {
    const { link, controls, fireNext, timers } = setup();
    link.start();
    controls[0]!.opened();
    expect(fireNext()).toBe(20_000);
    expect(fireNext()).toBe(20_000);
    expect(controls[0]!.sent).toEqual(['ping', 'ping']);
    controls[0]!.drop();
    // Only the redial remains armed.
    expect(timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([1000]);
  });

  it('treats the heartbeat reply as nothing to act on', async () => {
    const { link, controls, dials } = setup();
    link.start();
    controls[0]!.receive('pong');
    await flush();
    expect(dials).toEqual([]);
  });

  it('ignores control frames it does not understand', async () => {
    const { link, controls, dials } = setup();
    link.start();
    controls[0]!.receive('not json');
    controls[0]!.receive(JSON.stringify({ type: 'dial' }));
    controls[0]!.receive(JSON.stringify({ type: 'other', id: 'x' }));
    await flush();
    expect(dials).toEqual([]);
  });

  it('logs a failed dial instead of throwing', async () => {
    const { link, controls, sockets, logs } = setup(() => Promise.reject(new Error('refused')));
    link.start();
    controls[0]!.receive(JSON.stringify({ type: 'dial', id: 'a1' }));
    await flush();
    expect(sockets).toEqual([]);
    expect(logs.some((l) => l.includes('refused'))).toBe(true);
  });

  it('redials the control socket with exponential backoff, capped', () => {
    const { link, controls, fireNext } = setup();
    link.start();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      controls[i]!.drop();
      delays.push(fireNext());
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(controls).toHaveLength(8);
  });

  it('resets the backoff once the control socket opens', () => {
    const { link, controls, fireNext } = setup();
    link.start();
    controls[0]!.drop();
    fireNext();
    controls[1]!.drop();
    fireNext();
    controls[2]!.opened();
    controls[2]!.drop();
    expect(fireNext()).toBe(1000);
  });

  it('names the relay in its log lines, keeping the phrases the runbook greps for', () => {
    const { link, controls, logs } = setup();
    link.start();
    controls[0]!.opened();
    controls[0]!.drop();
    expect(logs).toEqual([
      'relay control socket open (wss://relay.example.com)',
      'relay control socket closed (wss://relay.example.com); redialing in 1000ms',
    ]);
  });

  describe('when another agent with the same key supersedes it', () => {
    const MINUTE = 60_000;

    it('backs off for a minute instead of redialing at once, and says why', () => {
      const { link, controls, fireNext, logs } = setup();
      link.start();
      controls[0]!.opened();
      controls[0]!.drop(4000);
      expect(fireNext()).toBe(MINUTE);
      expect(logs.at(-1)).toMatch(/superseded by another agent using this relay key.*60s/);
      expect(logs.at(-1)).toContain('wss://relay.example.com');
    });

    it('doubles the back-off on each supersede, even though the socket opened in between, up to 15 minutes', () => {
      const { link, controls, fireNext, clock } = setup();
      link.start();
      const delays: number[] = [];
      for (let i = 0; i < 6; i++) {
        controls[i]!.opened();
        // Held the relay for a while each time: the rival agent's own back-off.
        clock.now += 10 * MINUTE;
        controls[i]!.drop(4000);
        delays.push(fireNext());
      }
      expect(delays).toEqual([1, 2, 4, 8, 15, 15].map((m) => m * MINUTE));
    });

    it('starts over once it has held the relay for an hour', () => {
      const { link, controls, fireNext, clock } = setup();
      link.start();
      controls[0]!.opened();
      controls[0]!.drop(4000);
      fireNext();
      controls[1]!.opened();
      clock.now += 60 * MINUTE;
      controls[1]!.drop(4000);
      expect(fireNext()).toBe(MINUTE);
    });

    it('returns to the ordinary back-off for an ordinary close', () => {
      const { link, controls, fireNext } = setup();
      link.start();
      controls[0]!.opened();
      controls[0]!.drop(4000);
      fireNext();
      controls[1]!.opened();
      controls[1]!.drop(1006);
      expect(fireNext()).toBe(1000);
    });
  });

  describe('device policy', () => {
    const policy: RelayPolicy = { type: 'policy', devices: ['A'.repeat(43)], revoked: [], enrol: true };
    const key = 'B'.repeat(43);

    it('publishes the policy as soon as the control socket opens, and again on request', async () => {
      const { link, controls } = setup(undefined, { policy: async () => policy });
      link.start();
      await link.publish();
      expect(controls[0]!.sent).toEqual([]);
      controls[0]!.opened();
      await flush();
      expect(controls[0]!.sent).toEqual([JSON.stringify(policy)]);
      await link.publish();
      expect(controls[0]!.sent).toHaveLength(2);
    });

    it('republishes on every reconnect', async () => {
      const { link, controls, fireNext } = setup(undefined, { policy: async () => policy });
      link.start();
      controls[0]!.opened();
      controls[0]!.drop();
      fireNext();
      controls[1]!.opened();
      await flush();
      expect(controls[1]!.sent).toEqual([JSON.stringify(policy)]);
    });

    it('publishes again on each heartbeat until the relay acknowledges the policy', async () => {
      // A relay upgraded under a live control socket lost what the old code was sent.
      const { link, controls, fireNext } = setup(undefined, { policy: async () => policy });
      link.start();
      controls[0]!.opened();
      await flush();
      fireNext();
      await flush();
      expect(controls[0]!.sent).toEqual([JSON.stringify(policy), 'ping', JSON.stringify(policy)]);
      controls[0]!.receive('{"type":"applied"}');
      fireNext();
      await flush();
      expect(controls[0]!.sent.slice(3)).toEqual(['ping']);
      await link.publish();
      fireNext();
      await flush();
      expect(controls[0]!.sent.slice(4)).toEqual([JSON.stringify(policy), 'ping', JSON.stringify(policy)]);
    });

    it('says once, in its log, that a policy too large for the relay will not be applied', async () => {
      const keys = Array.from({ length: 257 }, (_, i) => String(i).padStart(43, 'A'));
      const { link, controls, logs, fireNext } = setup(undefined, { policy: async () => ({ ...policy, devices: keys }) });
      link.start();
      controls[0]!.opened();
      await flush();
      fireNext();
      await flush();
      expect(logs.filter((l) => /257 enrolled/.test(l))).toHaveLength(1);
    });

    it('dials for an enrolment only once the agent has checked its proof', async () => {
      const seen: unknown[] = [];
      const { link, controls, dials } = setup(undefined, {
        admitEnrolment: async (enrol) => {
          seen.push(enrol);
          return { admitted: true };
        },
      });
      link.start();
      controls[0]!.opened();
      const enrol = { device: key, nonce: 'n', proof: 'p' };
      controls[0]!.receive(JSON.stringify({ type: 'dial', id: 'a1', enrol }));
      await flush();
      expect(seen).toEqual([enrol]);
      expect(dials).toHaveLength(1);
    });

    const expired: EnrolmentVerdict = { admitted: false, reason: 'pairing code expired', detail: 'its pairing code expired 49 s ago' };
    const unknown: EnrolmentVerdict = { admitted: false, reason: 'enrolment proof invalid', detail: 'its token proof did not verify (a wrong token)' };

    it('tells the relay to refuse an enrolment, and why, logs what went wrong, and does not dial', async () => {
      const { link, controls, dials, logs } = setup(undefined, { admitEnrolment: async () => expired });
      link.start();
      controls[0]!.opened();
      controls[0]!.receive(JSON.stringify({ type: 'dial', id: 'a1', enrol: { device: key, nonce: 'n', proof: 'p' } }));
      await flush();
      expect(dials).toEqual([]);
      expect(controls[0]!.sent).toEqual([JSON.stringify({ type: 'refuse', id: 'a1', reason: 'pairing code expired' })]);
      expect(logs.at(-1)).toBe('refused an enrolment through wss://relay.example.com: its pairing code expired 49 s ago');
    });

    it("does not let a stranger's refusals hide the owner's in the log", async () => {
      const verdicts = [unknown, expired];
      const { link, controls, logs } = setup(undefined, { admitEnrolment: async () => verdicts.shift()! });
      link.start();
      controls[0]!.opened();
      for (const id of ['a1', 'a2']) controls[0]!.receive(JSON.stringify({ type: 'dial', id, enrol: { device: key, nonce: 'n', proof: 'p' } }));
      await flush();
      expect(logs.filter((line) => line.includes('refused'))).toHaveLength(2);
    });

    it('logs refused enrolments at most once a minute per reason, with how many it held back', async () => {
      const { link, controls, logs, clock } = setup(undefined, { admitEnrolment: async () => unknown });
      link.start();
      controls[0]!.opened();
      const refusals = () => logs.filter((line) => line.includes('refused'));
      const attempt = async (id: string) => {
        controls[0]!.receive(JSON.stringify({ type: 'dial', id, enrol: { device: key, nonce: 'n', proof: 'p' } }));
        await flush();
      };
      await attempt('a1');
      await attempt('a2');
      await attempt('a3');
      expect(refusals()).toHaveLength(1);
      expect(controls[0]!.sent.filter((m) => m.includes('refuse'))).toHaveLength(3);
      clock.now += 60_000;
      await attempt('a4');
      expect(refusals()).toHaveLength(2);
      expect(refusals()[1]).toMatch(/\(and 2 more in the last minute\)$/);
    });

    // Each check reads the roster and the pairing file; a hostile relay ignores its own budget.
    it('checks at most 4 enrolments at once, refusing the rest without looking', async () => {
      const waiting: Array<() => void> = [];
      const { link, controls } = setup(undefined, {
        admitEnrolment: () => new Promise((resolve) => waiting.push(() => resolve({ admitted: true }))),
      });
      link.start();
      controls[0]!.opened();
      for (let i = 0; i < 6; i++) controls[0]!.receive(JSON.stringify({ type: 'dial', id: `e${i}`, enrol: { device: key, nonce: 'n', proof: 'p' } }));
      expect(waiting).toHaveLength(4);
      expect(controls[0]!.sent.filter((m) => m.includes('refuse'))).toEqual([
        JSON.stringify({ type: 'refuse', id: 'e4', reason: 'too many enrolment attempts' }),
        JSON.stringify({ type: 'refuse', id: 'e5', reason: 'too many enrolment attempts' }),
      ]);
      waiting.splice(0).forEach((admit) => admit());
      await flush();
      controls[0]!.receive(JSON.stringify({ type: 'dial', id: 'e6', enrol: { device: key, nonce: 'n', proof: 'p' } }));
      expect(waiting).toHaveLength(1);
    });

    it('checks at most 10 enrolments a minute', async () => {
      let checks = 0;
      const { link, controls, clock } = setup(undefined, { admitEnrolment: async () => (checks++, unknown) });
      link.start();
      controls[0]!.opened();
      const attempt = async (id: string) => {
        controls[0]!.receive(JSON.stringify({ type: 'dial', id, enrol: { device: key, nonce: 'n', proof: 'p' } }));
        await flush();
      };
      for (let i = 0; i < 12; i++) await attempt(`e${i}`);
      expect(checks).toBe(10);
      expect(controls[0]!.sent.filter((m) => m.includes('too many enrolment attempts'))).toHaveLength(2);
      clock.now += 60_000;
      await attempt('later');
      expect(checks).toBe(11);
    });

    it('refuses every enrolment when it has no way to check one', async () => {
      const { link, controls, dials, logs } = setup();
      link.start();
      controls[0]!.opened();
      controls[0]!.receive(JSON.stringify({ type: 'dial', id: 'a1', enrol: { device: key, nonce: 'n', proof: 'p' } }));
      await flush();
      expect(dials).toEqual([]);
      expect(controls[0]!.sent).toEqual([JSON.stringify({ type: 'refuse', id: 'a1' })]);
      expect(logs.at(-1)).toMatch(/could not check its proof/);
    });
  });

  it('stops redialing once stopped', () => {
    const { link, controls, timers } = setup();
    link.start();
    link.stop();
    expect(controls[0]!.closed).toBe(true);
    expect(timers.filter((t) => !t.cancelled)).toEqual([]);
  });
});
