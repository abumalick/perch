import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@perch/contracts';
import type { BrowserStreamSocket } from '../ports/browser-stream-port';
import { MAX_BROWSER_STREAMS, SessionBrowserStreams } from './session-browser-streams';

function setup() {
  const sent: AgentMessage[] = [];
  const opened: Array<{ socket: BrowserStreamSocket; session: string; received: string[]; closed: number; drained: number }> = [];
  const streams = new SessionBrowserStreams({
    send: (m) => sent.push(m),
    serve: (socket, session) => {
      const entry = { socket, session, received: [] as string[], closed: 0, drained: 0 };
      socket.onMessage((d) => entry.received.push(d));
      socket.onClose(() => (entry.closed += 1));
      socket.onDrain?.(() => (entry.drained += 1));
      opened.push(entry);
    },
  });
  return { sent, opened, streams };
}

describe('SessionBrowserStreams', () => {
  it('serves each opened stream with its session name and delivers its messages', () => {
    const { opened, streams } = setup();
    streams.open('b1', 'perch-demo');
    streams.deliver('b1', '{"type":"auth","token":"t"}');
    streams.deliver('nope', '{"type":"ping"}');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.session).toBe('perch-demo');
    expect(opened[0]!.received).toEqual(['{"type":"auth","token":"t"}']);
  });

  it('wraps what the handler sends into the stream, counting it as buffered until acknowledged', () => {
    const { sent, opened, streams } = setup();
    streams.open('b1', 's');
    const socket = opened[0]!.socket;
    socket.send('12345');
    socket.send('678');
    expect(sent).toEqual([
      { type: 'browser', stream: 'b1', data: '12345' },
      { type: 'browser', stream: 'b1', data: '678' },
    ]);
    expect(socket.bufferedAmount!()).toBe(8);
    streams.ack('b1');
    expect(socket.bufferedAmount!()).toBe(3);
    expect(opened[0]!.drained).toBe(1);
    streams.ack('b1');
    streams.ack('b1');
    streams.ack('b1');
    expect(socket.bufferedAmount!()).toBe(0);
    expect(opened[0]!.drained).toBe(2);
  });

  it('tells the phone when the handler closes the stream, once', () => {
    const { sent, opened, streams } = setup();
    streams.open('b1', 's');
    opened[0]!.socket.close();
    opened[0]!.socket.close();
    expect(sent).toEqual([{ type: 'browserClosed', stream: 'b1' }]);
    expect(opened[0]!.closed).toBe(1);
    opened[0]!.socket.send('late');
    streams.deliver('b1', 'late');
    expect(sent).toHaveLength(1);
    expect(opened[0]!.received).toEqual([]);
  });

  it('closes the handler side when the phone closes the stream, without echoing a close', () => {
    const { sent, opened, streams } = setup();
    streams.open('b1', 's');
    streams.close('b1');
    expect(opened[0]!.closed).toBe(1);
    expect(sent).toEqual([]);
  });

  it('closes every stream when the connection goes away', () => {
    const { opened, streams } = setup();
    streams.open('b1', 's');
    streams.open('b2', 't');
    streams.closeAll();
    expect(opened.map((o) => o.closed)).toEqual([1, 1]);
  });

  it('replaces a stream reopened under the same id', () => {
    const { opened, streams } = setup();
    streams.open('b1', 's');
    streams.open('b1', 's');
    expect(opened.map((o) => o.closed)).toEqual([1, 0]);
  });

  it('refuses a stream past the cap', () => {
    const { sent, opened, streams } = setup();
    for (let i = 0; i < MAX_BROWSER_STREAMS; i += 1) streams.open(`b${i}`, 's');
    streams.open('extra', 's');
    expect(opened).toHaveLength(MAX_BROWSER_STREAMS);
    expect(sent).toEqual([{ type: 'browserClosed', stream: 'extra' }]);
  });
});
