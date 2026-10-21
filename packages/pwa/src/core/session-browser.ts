import type { AgentMessage, ClientMessage } from '@perch/contracts';
import type { CloseInfo, Socket, SocketFactory } from './ports/socket';

export interface SessionBrowserDeps {
  send: (message: ClientMessage) => void;
  newId: () => string;
  isOnline: () => boolean;
}

interface Stream {
  messageListeners: Array<(data: string) => void>;
  closeListeners: Array<(info?: CloseInfo) => void>;
  closed: boolean;
}

// Browser views carried inside the machine's connection, each as a stream that looks to
// BrowserStream like a socket of its own, so the viewer keeps its socket-shaped heartbeat and
// reconnects. Every message the agent
// sends on a stream is acknowledged: those acknowledgements are how the agent learns that a
// slow phone is behind and replaces the frame it holds instead of queueing more.
export class SessionBrowser {
  private readonly streams = new Map<string, Stream>();

  constructor(private readonly deps: SessionBrowserDeps) {}

  // The factory's argument is the browser session's name.
  readonly socketFactory: SocketFactory = (session) => {
    const stream = this.deps.newId();
    const state: Stream = { messageListeners: [], closeListeners: [], closed: false };
    const openListeners: Array<() => void> = [];
    const socket: Socket = {
      send: (data) => {
        if (!state.closed) this.deps.send({ type: 'browser', stream, data });
      },
      close: () => {
        if (state.closed) return;
        this.deps.send({ type: 'browserClose', stream });
        this.end(stream, { code: 1000 });
      },
      onMessage: (cb) => void state.messageListeners.push(cb),
      onOpen: (cb) => void openListeners.push(cb),
      onClose: (cb) => void state.closeListeners.push(cb),
    };
    this.streams.set(stream, state);
    // Deferred so the caller has registered its listeners, as with a real socket.
    queueMicrotask(() => {
      if (state.closed) return;
      if (!this.deps.isOnline()) {
        this.end(stream, { code: 1006, reason: 'machine offline' });
        return;
      }
      this.deps.send({ type: 'browserOpen', stream, session });
      openListeners.forEach((l) => l());
    });
    return socket;
  };

  // Returns whether the message belonged to a browser stream.
  handle(message: AgentMessage): boolean {
    if (message.type === 'browser') {
      const state = this.streams.get(message.stream);
      if (!state || state.closed) return true;
      state.messageListeners.forEach((l) => l(message.data));
      this.deps.send({ type: 'browserAck', stream: message.stream });
      return true;
    }
    if (message.type === 'browserClosed') {
      this.end(message.stream, { code: 1000 });
      return true;
    }
    return false;
  }

  // The connection dropped: every stream went with it.
  offline(): void {
    for (const stream of [...this.streams.keys()]) this.end(stream, { code: 1006, reason: 'machine offline' });
  }

  private end(stream: string, info: CloseInfo): void {
    const state = this.streams.get(stream);
    if (!state || state.closed) return;
    state.closed = true;
    this.streams.delete(stream);
    state.closeListeners.forEach((l) => l(info));
  }
}
