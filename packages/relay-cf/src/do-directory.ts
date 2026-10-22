import { sameLabel, type Peer, type PeerDirectory, type PeerLabel } from '@perch/relay';

// The relay core's socket directory over a Durable Object's hibernatable WebSockets. A socket's
// role lives in its serialized attachment, which the runtime keeps across hibernation, so nothing
// has to be rebuilt when the object wakes: every lookup goes back to `ctx.getWebSockets`. Tags are
// fixed at accept, and a gate later becomes a client, so they are only the fallback for a socket
// accepted before labels moved to the attachment.
export class DoDirectory implements PeerDirectory {
  private readonly peers = new WeakMap<WebSocket, Peer>();
  private readonly sockets = new WeakMap<Peer, WebSocket>();
  // Every forwarded frame looks labels up, and reading an attachment deserializes it.
  private readonly labels = new WeakMap<WebSocket, PeerLabel | null>();

  constructor(private readonly ctx: DurableObjectState) {}

  accept(socket: WebSocket, label: PeerLabel): Peer {
    this.ctx.acceptWebSocket(socket, tagsFor(label));
    socket.serializeAttachment(label);
    this.labels.set(socket, label);
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
    return this.open()
      .filter((socket) => {
        const own = this.labelOfSocket(socket);
        return own !== null && sameLabel(own, label);
      })
      .map((socket) => this.peerOf(socket));
  }

  all(): Peer[] {
    return this.open().map((socket) => this.peerOf(socket));
  }

  labelOf(peer: Peer): PeerLabel | null {
    const socket = this.sockets.get(peer);
    return socket ? this.labelOfSocket(socket) : null;
  }

  relabel(peer: Peer, label: PeerLabel): void {
    const socket = this.sockets.get(peer);
    if (!socket) return;
    socket.serializeAttachment(label);
    this.labels.set(socket, label);
  }

  count(kind: PeerLabel['kind']): number {
    return this.open().filter((socket) => this.labelOfSocket(socket)?.kind === kind).length;
  }

  private labelOfSocket(socket: WebSocket): PeerLabel | null {
    let label = this.labels.get(socket);
    if (label === undefined) {
      label = (socket.deserializeAttachment() as PeerLabel | null) ?? labelFromTags(this.ctx.getTags(socket));
      this.labels.set(socket, label);
    }
    return label;
  }

  private open(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN);
  }
}

function tagsFor(label: PeerLabel): string[] {
  return 'pair' in label ? [label.kind, `pair:${label.pair}:${label.kind}`] : [label.kind];
}

export function labelFromTags(tags: string[]): PeerLabel | null {
  if (tags.includes('control')) return { kind: 'control' };
  if (tags.includes('gate')) return { kind: 'gate' };
  for (const tag of tags) {
    const match = /^pair:(.+):(client|agent)$/.exec(tag);
    if (match) return { kind: match[2] as 'client' | 'agent', pair: match[1]! };
  }
  return null;
}
