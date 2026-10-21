import type { AgentMessage } from '@perch/contracts';
import type { BrowserStreamSocket } from '../ports/browser-stream-port';

// Browser views one connection may hold at once. The PWA shows one; a few more cover a view
// reopened before the agent has seen the old one close.
export const MAX_BROWSER_STREAMS = 4;

export interface SessionBrowserStreamsDeps {
  send(message: AgentMessage): void;
  // Serves one browser view over the given socket (a BrowserStreamHandler in production).
  serve(socket: BrowserStreamSocket, session: string): void;
}

// Browser views carried inside the client connection, so through a relay they ride the
// end-to-end session. Each stream looks to its handler like a socket of its own. Its
// `bufferedAmount` is the bytes the phone has not yet acknowledged: the agent's own socket
// drains into the relay at once, so only the phone can say that it is falling behind.
export class SessionBrowserStreams {
  private readonly streams = new Map<string, StreamSocket>();

  constructor(private readonly deps: SessionBrowserStreamsDeps) {}

  open(stream: string, session: string): void {
    this.streams.get(stream)?.end();
    if (this.streams.size >= MAX_BROWSER_STREAMS) {
      this.deps.send({ type: 'browserClosed', stream });
      return;
    }
    const socket = new StreamSocket(stream, this.deps.send, () => {
      if (this.streams.get(stream) === socket) this.streams.delete(stream);
    });
    this.streams.set(stream, socket);
    this.deps.serve(socket, session);
  }

  deliver(stream: string, data: string): void {
    this.streams.get(stream)?.deliver(data);
  }

  ack(stream: string): void {
    this.streams.get(stream)?.ack();
  }

  close(stream: string): void {
    this.streams.get(stream)?.end();
  }

  closeAll(): void {
    for (const socket of [...this.streams.values()]) socket.end();
  }
}

class StreamSocket implements BrowserStreamSocket {
  private closed = false;
  private readonly unacked: number[] = [];
  private buffered = 0;
  private readonly messageListeners: Array<(data: string) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  private readonly drainListeners: Array<() => void> = [];

  constructor(
    private readonly stream: string,
    private readonly sendMessage: (message: AgentMessage) => void,
    private readonly forget: () => void,
  ) {}

  send(data: string): void {
    if (this.closed) return;
    this.unacked.push(data.length);
    this.buffered += data.length;
    this.sendMessage({ type: 'browser', stream: this.stream, data });
  }

  bufferedAmount(): number {
    return this.buffered;
  }

  onDrain(listener: () => void): void {
    this.drainListeners.push(listener);
  }

  onMessage(listener: (data: string) => void): void {
    this.messageListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  // The handler ends the stream: tell the phone.
  close(): void {
    if (this.closed) return;
    this.sendMessage({ type: 'browserClosed', stream: this.stream });
    this.end();
  }

  deliver(data: string): void {
    if (!this.closed) this.messageListeners.forEach((l) => l(data));
  }

  // An acknowledgement for nothing in flight is ignored, never allowed to open the window.
  ack(): void {
    const size = this.unacked.shift();
    if (size === undefined) return;
    this.buffered -= size;
    this.drainListeners.forEach((l) => l());
  }

  // The phone closed it or the connection went away: nobody to tell.
  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.forget();
    this.closeListeners.forEach((l) => l());
  }
}
