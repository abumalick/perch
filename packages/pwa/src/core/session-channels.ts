import type { AgentMessage, ClientLogBatch, ClientMessage } from '@perch/contracts';
import { startTimer } from '@perch/secure-channel';
import { SessionMedia } from './session-media';
import { SessionBrowser } from './session-browser';

// No acknowledgement within this long counts as a failed flush; the events stay buffered.
const LOG_ACK_MS = 10_000;

export interface SessionChannelsDeps {
  send: (message: ClientMessage) => void;
  isOnline: () => boolean;
  startTimer?: (fn: () => void, ms: number) => () => void;
}

// The side channels of one machine connection: media previews, the browser view and the
// connection-log flush, all inside its end-to-end session.
export class SessionChannels {
  readonly media: SessionMedia;
  readonly browser: SessionBrowser;
  private readonly logAcks = new Map<string, (ok: boolean) => void>();
  private next = 0;
  private readonly startTimer: (fn: () => void, ms: number) => () => void;

  constructor(private readonly deps: SessionChannelsDeps) {
    this.startTimer = deps.startTimer ?? startTimer;
    const newId = () => `c${(this.next += 1)}`;
    this.media = new SessionMedia({ send: deps.send, newId, startTimer: deps.startTimer });
    this.browser = new SessionBrowser({ send: deps.send, newId, isOnline: deps.isOnline });
  }

  // A LogSender over the session: true once the agent acknowledges having stored the batch.
  readonly sendLog = (batch: ClientLogBatch): Promise<boolean> => {
    if (!this.deps.isOnline()) return Promise.resolve(false);
    const id = `c${(this.next += 1)}`;
    return new Promise((resolve) => {
      const cancel = this.startTimer(() => settle(false), LOG_ACK_MS);
      const settle = (ok: boolean) => {
        if (!this.logAcks.delete(id)) return;
        cancel();
        resolve(ok);
      };
      this.logAcks.set(id, settle);
      this.deps.send({ type: 'clientLog', id, batch });
    });
  };

  // Returns whether the message belonged to a side channel.
  handle(message: AgentMessage): boolean {
    if (message.type === 'clientLogAck') {
      this.logAcks.get(message.id)?.(message.ok);
      return true;
    }
    return this.media.handle(message) || this.browser.handle(message);
  }

  offline(): void {
    this.media.offline();
    this.browser.offline();
    for (const settle of [...this.logAcks.values()]) settle(false);
  }
}
