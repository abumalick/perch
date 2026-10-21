import { describe, it, expect } from 'vitest';
import type { ClientMessage } from '@perch/contracts';
import { SessionBrowser } from './session-browser';
import { BrowserStream } from './browser-stream';

const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(online = true) {
  const sent: ClientMessage[] = [];
  let n = 0;
  let isOnline = online;
  const browser = new SessionBrowser({
    send: (m) => sent.push(m),
    newId: () => `b${(n += 1)}`,
    isOnline: () => isOnline,
  });
  return { sent, browser, setOnline: (v: boolean) => (isOnline = v) };
}

describe('SessionBrowser', () => {
  it('opens a stream for the session, then carries the browser protocol inside it', async () => {
    const { sent, browser } = setup();
    const socket = browser.socketFactory('perch-demo');
    let opened = false;
    socket.onOpen(() => (opened = true));
    await settle();
    expect(opened).toBe(true);
    socket.send('{"type":"auth","token":"t"}');
    expect(sent).toEqual([
      { type: 'browserOpen', stream: 'b1', session: 'perch-demo' },
      { type: 'browser', stream: 'b1', data: '{"type":"auth","token":"t"}' },
    ]);
  });

  it('delivers what the agent sends on the stream and acknowledges each message', async () => {
    const { sent, browser } = setup();
    const socket = browser.socketFactory('s');
    const received: string[] = [];
    socket.onMessage((d) => received.push(d));
    await settle();
    sent.length = 0;
    expect(browser.handle({ type: 'browser', stream: 'b1', data: 'one' })).toBe(true);
    browser.handle({ type: 'browser', stream: 'other', data: 'nope' });
    expect(received).toEqual(['one']);
    expect(sent).toEqual([{ type: 'browserAck', stream: 'b1' }]);
  });

  it('closes when the agent ends the stream, and when the machine goes offline', async () => {
    const { browser } = setup();
    const a = browser.socketFactory('s');
    const b = browser.socketFactory('t');
    const closes: Array<number | undefined> = [];
    a.onClose((i) => closes.push(i?.code));
    b.onClose((i) => closes.push(i?.code));
    await settle();
    browser.handle({ type: 'browserClosed', stream: 'b1' });
    browser.offline();
    expect(closes).toEqual([1000, 1006]);
  });

  it('tells the agent when the viewer closes it, and stops sending', async () => {
    const { sent, browser } = setup();
    const socket = browser.socketFactory('s');
    await settle();
    socket.close();
    socket.send('late');
    browser.handle({ type: 'browser', stream: 'b1', data: 'late' });
    expect(sent.map((m) => m.type)).toEqual(['browserOpen', 'browserClose']);
  });

  it('fails at once while the machine is offline, so the viewer backs off and retries', async () => {
    const { sent, browser } = setup(false);
    const socket = browser.socketFactory('s');
    let closed = false;
    socket.onClose(() => (closed = true));
    await settle();
    expect(closed).toBe(true);
    expect(sent).toEqual([]);
  });

  it('drives BrowserStream unchanged: auth, frames, and the terminal end reasons', async () => {
    const { sent, browser } = setup();
    const states: string[] = [];
    const frames: string[] = [];
    let ended: string | null = null;
    const stream = new BrowserStream({
      url: 'perch-demo',
      socketFactory: browser.socketFactory,
      onFrame: (d) => frames.push(d),
      onUrl: () => undefined,
      onState: (s) => states.push(s),
      endedReason: (r) => (ended = r),
      schedule: () => undefined,
      startTimer: () => () => undefined,
    });
    stream.open();
    await settle();
    expect(sent).toEqual([
      { type: 'browserOpen', stream: 'b1', session: 'perch-demo' },
      { type: 'browser', stream: 'b1', data: JSON.stringify({ type: 'auth', token: '' }) },
    ]);
    browser.handle({ type: 'browser', stream: 'b1', data: JSON.stringify({ type: 'authResult', ok: true }) });
    browser.handle({
      type: 'browser',
      stream: 'b1',
      data: JSON.stringify({ type: 'frame', data: 'jpeg', metadata: { deviceWidth: 1, deviceHeight: 1 } }),
    });
    browser.handle({ type: 'browser', stream: 'b1', data: JSON.stringify({ type: 'ended', reason: 'opened-elsewhere' }) });
    browser.handle({ type: 'browserClosed', stream: 'b1' });
    expect(states).toEqual(['connecting', 'online', 'ended']);
    expect(frames).toEqual(['jpeg']);
    expect(ended).toBe('opened-elsewhere');
  });
});
