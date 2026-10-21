import { audioMediaType, imageMediaType, pdfMediaType, type AgentMessage, type ClientMessage, type MediaResult } from '@perch/contracts';
import { startTimer } from '@perch/secure-channel';

// The largest file the agent serves (audio, 30 MB). A header announcing more is refused
// outright rather than buffered.
export const MAX_MEDIA_BYTES = 30 * 1024 * 1024;
// No message for this long means the transfer is dead (the agent, or the relay, went quiet
// without closing the connection).
const STALL_MS = 20_000;

// A read's outcome, as the agent put it, with the bytes when it succeeded.
export type MediaReadResult = { result: 'ok'; blob: Blob } | { result: Exclude<MediaResult, 'ok'> };

interface Pending {
  id: string;
  resolve: (result: MediaReadResult) => void;
  reject: (err: Error) => void;
  // The type the path implies, which the Blob is built with whatever the agent says: a blob: URL
  // has the PWA's origin, so a `.pdf` the agent answered as `text/html` would run its script here.
  expectedType: string;
  mediaType: string | null;
  size: number;
  received: number;
  nextSeq: number;
  parts: Uint8Array[];
  cancelStall: () => void;
}

export interface SessionMediaDeps {
  send: (message: ClientMessage) => void;
  newId: () => string;
  startTimer?: (fn: () => void, ms: number) => () => void;
}

// Reads a media file (image, PDF, audio) through the machine's own connection: the agent sends
// it as chunks and waits for each one's acknowledgement before sending more, so a preview never
// queues more than a few chunks ahead of terminal output. One read at a time: the viewer shows
// one file, and a newer read cancels the older one on both sides.
export class SessionMedia {
  private pending: Pending | null = null;
  private readonly startTimer: (fn: () => void, ms: number) => () => void;

  constructor(private readonly deps: SessionMediaDeps) {
    this.startTimer = deps.startTimer ?? startTimer;
  }

  read(path: string): Promise<MediaReadResult> {
    this.cancel();
    const id = this.deps.newId();
    return new Promise((resolve, reject) => {
      this.pending = {
        id,
        resolve,
        reject,
        expectedType: imageMediaType(path) || pdfMediaType(path) || audioMediaType(path) || 'application/octet-stream',
        mediaType: null,
        size: 0,
        received: 0,
        nextSeq: 0,
        parts: [],
        cancelStall: () => undefined,
      };
      this.armStall();
      this.deps.send({ type: 'readMedia', id, path });
    });
  }

  // Returns whether the message belonged to media.
  handle(message: AgentMessage): boolean {
    if (message.type === 'media') {
      const p = this.pending;
      if (!p || p.id !== message.id || p.mediaType !== null) return true;
      if (message.result !== 'ok') {
        this.settle({ result: message.result });
        return true;
      }
      const size = message.size ?? 0;
      if (size > MAX_MEDIA_BYTES) {
        this.cancel(new Error('media larger than any file the agent serves'));
        return true;
      }
      if (message.mediaType !== undefined && message.mediaType !== p.expectedType) {
        this.cancel(new Error(`media type ${message.mediaType} does not match the file's own`));
        return true;
      }
      p.mediaType = p.expectedType;
      p.size = size;
      this.armStall();
      if (size === 0) this.settle({ result: 'ok', blob: new Blob([], { type: p.mediaType }) });
      return true;
    }
    if (message.type === 'mediaChunk') {
      const p = this.pending;
      if (!p || p.id !== message.id || p.mediaType === null) return true;
      const bytes = decodeBase64(message.data);
      if (message.seq !== p.nextSeq || p.received + bytes.length > p.size) {
        this.cancel(new Error('media stream out of order'));
        return true;
      }
      p.parts.push(bytes);
      p.received += bytes.length;
      p.nextSeq += 1;
      this.deps.send({ type: 'mediaAck', id: p.id, seq: message.seq });
      if (p.received === p.size) {
        this.settle({ result: 'ok', blob: new Blob(p.parts as BlobPart[], { type: p.mediaType }) });
      } else {
        this.armStall();
      }
      return true;
    }
    return false;
  }

  // Abandons the read in progress, telling the agent to stop sending it.
  cancel(reason = new Error('media read cancelled')): void {
    const p = this.pending;
    if (!p) return;
    this.deps.send({ type: 'mediaCancel', id: p.id });
    this.fail(reason);
  }

  // The connection dropped: nothing more will arrive.
  offline(): void {
    this.fail(new Error('machine went offline'));
  }

  private settle(result: MediaReadResult): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.cancelStall();
    p.resolve(result);
  }

  private fail(err: Error): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.cancelStall();
    p.reject(err);
  }

  private armStall(): void {
    const p = this.pending!;
    p.cancelStall();
    p.cancelStall = this.startTimer(() => {
      if (this.pending === p) this.cancel(new Error('media read stalled'));
    }, STALL_MS);
  }
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
