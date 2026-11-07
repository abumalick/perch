import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import type { ClaudeSessionsPort } from '../ports/claude-sessions-port';
import type { DeliveryTarget, MessageDelivery } from '../ports/message-delivery-port';

export const PINNED_PEER_PROTOCOL = 1;
const TIMEOUT_MS = 5_000;
// Claude refuses a frame over 1 MiB; stay clear of it.
const MAX_FRAME_BYTES = 1_000_000;

type Result = { ok: true } | { ok: false; reason: string };

// Writes a message into a Claude Code session's peer inbox, the socket its own SendMessage
// uses. Claude answers nothing, so a dropped or held message is invisible: "ok" means the
// frame was written and the socket closed cleanly, never that the session read it.
export class ClaudeInboxDelivery implements MessageDelivery {
  constructor(
    private readonly sessions: ClaudeSessionsPort,
    // The id (`%N`) of a tmux session's first pane, which picks among several live Claude sessions.
    private readonly firstPane: (id: string) => Promise<string | null> = async () => null,
  ) {}

  async deliver(target: DeliveryTarget, text: string): Promise<Result> {
    const inbox = await this.sessions.inboxOf(target.id, await this.firstPane(target.id));
    if (!inbox) return { ok: false, reason: `no live Claude session in ${target.id}` };
    if (inbox === 'ambiguous') return { ok: false, reason: `several Claude sessions in ${target.id}; retry in a few seconds` };
    if (inbox.peerProtocol !== PINNED_PEER_PROTOCOL) {
      return {
        ok: false,
        reason: `Claude peer protocol ${inbox.peerProtocol} is not supported (expected ${PINNED_PEER_PROTOCOL})`,
      };
    }
    const fromName = target.from.replace(/["<>]/g, '');
    const frame = JSON.stringify({
      msgV: 1,
      msg_id: randomUUID(),
      type: 'user',
      message: {
        role: 'user',
        // A closing tag inside the text would end the envelope early, and an opening one would
        // let the rest pose as a second message from another sender: both are escaped.
        content: `<cross-session-message from-name="${fromName}">\n${text.replace(/<(\/?cross-session-message)/gi, '&lt;$1')}\n</cross-session-message>`,
      },
      priority: 'next',
    });
    const bytes = Buffer.byteLength(frame, 'utf8');
    if (bytes > MAX_FRAME_BYTES) return { ok: false, reason: `message too large for Claude (${bytes} bytes)` };
    const auth = inbox.token === undefined ? '' : `${JSON.stringify({ type: 'auth', token: inbox.token })}\n`;
    return write(inbox.socketPath, `${auth}${frame}\n`, target.id);
  }
}

function write(socketPath: string, payload: string, id: string): Promise<Result> {
  return new Promise((resolve) => {
    const socket = connect(socketPath, () => socket.end(payload));
    const settle = (result: Result) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => settle({ ok: false, reason: 'the Claude inbox did not answer in 5 s' }), TIMEOUT_MS);
    socket.on('error', (err: NodeJS.ErrnoException) => {
      const unreachable = err.code === 'ENOENT' || err.code === 'ECONNREFUSED';
      settle({
        ok: false,
        reason: unreachable ? `the Claude inbox of ${id} is not reachable` : `the Claude inbox of ${id} failed: ${err.message}`,
      });
    });
    socket.on('close', (hadError) => {
      if (!hadError) settle({ ok: true });
    });
  });
}
