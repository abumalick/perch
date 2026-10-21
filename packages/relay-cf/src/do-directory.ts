import type { Peer, PeerDirectory, PeerLabel } from '@perch/relay';

// The relay core's socket directory over a Durable Object's hibernatable WebSockets. A socket's
// role lives in its tags, which the runtime keeps across hibernation, so nothing has to be
// rebuilt when the object wakes: every lookup goes back to `ctx.getWebSockets`.
export class DoDirectory implements PeerDirectory {
  private readonly peers = new WeakMap<WebSocket, Peer>();
  private readonly sockets = new WeakMap<Peer, WebSocket>();

  constructor(private readonly ctx: DurableObjectState) {}

  accept(socket: WebSocket, label: PeerLabel): Peer {
    this.ctx.acceptWebSocket(socket, tagsFor(label));
    return this.peerOf(socket);
  }

  // The same socket always maps to the same Peer, which the core compares by identity.
  peerOf(socket: WebSocket): Peer {
    let peer = this.peers.get(socket);
    if (!peer) {
      peer = {
        send: (data) => socket.send(data),
        close: (code, reason) => {
          try {
            socket.close(code, reason);
          } catch {
            // Already closing or closed.
          }
        },
      };
      this.peers.set(socket, peer);
      this.sockets.set(peer, socket);
    }
    return peer;
  }

  find(label: PeerLabel): Peer[] {
    return this.open(tagFor(label)).map((socket) => this.peerOf(socket));
  }

  all(): Peer[] {
    return this.ctx
      .getWebSockets()
      .filter((socket) => socket.readyState === WebSocket.OPEN)
      .map((socket) => this.peerOf(socket));
  }

  labelOf(peer: Peer): PeerLabel | null {
    const socket = this.sockets.get(peer);
    return socket ? labelFromTags(this.ctx.getTags(socket)) : null;
  }

  count(kind: PeerLabel['kind']): number {
    return this.open(kind).length;
  }

  private open(tag: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((socket) => socket.readyState === WebSocket.OPEN);
  }
}

function tagFor(label: PeerLabel): string {
  return label.kind === 'control' ? 'control' : `pair:${label.pair}:${label.kind}`;
}

function tagsFor(label: PeerLabel): string[] {
  return label.kind === 'control' ? ['control'] : [label.kind, tagFor(label)];
}

export function labelFromTags(tags: string[]): PeerLabel | null {
  if (tags.includes('control')) return { kind: 'control' };
  for (const tag of tags) {
    const match = /^pair:(.+):(client|agent)$/.exec(tag);
    if (match) return { kind: match[2] as 'client' | 'agent', pair: match[1]! };
  }
  return null;
}
