import type { AgentMessage, MediaResult } from '@perch/contracts';
import type { ReadServableFileResult } from './read-servable-file';

// One chunk stays inside a single Noise frame once base64'd into its JSON message (a frame
// carries 65 519 bytes of plaintext). A larger message would be sealed into several frames
// sent back to back, so terminal output could not slip in between them.
export const MEDIA_CHUNK_BYTES = 45 * 1024;
// Chunks in flight before the phone acknowledges one. Through a relay the agent cannot see the
// slow leg (relay → phone: its own socket drains into the relay at once), so the phone's
// acknowledgements are the only backpressure there is, and this window is the most a preview
// can put ahead of terminal output.
export const MEDIA_WINDOW = 4;

interface Transfer {
  id: string;
  bytes: Uint8Array;
  chunks: number;
  sent: number;
  acked: number;
}

// Sends one media file at a time over a client connection, for a PWA that previews images,
// PDFs and audio inside the session. A newer request supersedes the current one: the viewer
// shows one file, and an abandoned 20 MB PDF must not keep squatting the pipe.
export class MediaSender {
  // The id of the latest request, set before its file is read so one that is superseded
  // while reading is never answered.
  private latest: string | null = null;
  private transfer: Transfer | null = null;

  constructor(private readonly send: (message: AgentMessage) => void) {}

  async request(id: string, read: () => Promise<ReadServableFileResult>): Promise<void> {
    this.latest = id;
    this.transfer = null;
    let result: ReadServableFileResult;
    try {
      result = await read();
    } catch (err) {
      if (this.latest === id) {
        const missing = (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
        this.send({ type: 'media', id, result: missing ? 'not-found' : 'error' });
      }
      return;
    }
    if (this.latest !== id) return;
    if (result.kind !== 'ok') {
      this.send({ type: 'media', id, result: RESULTS[result.kind] });
      return;
    }
    this.send({ type: 'media', id, result: 'ok', mediaType: result.mediaType, size: result.bytes.byteLength });
    this.transfer = {
      id,
      bytes: result.bytes,
      chunks: Math.ceil(result.bytes.byteLength / MEDIA_CHUNK_BYTES),
      sent: 0,
      acked: 0,
    };
    this.pump();
  }

  // Acknowledgements arrive in order; anything else (a stale id, a repeat, a chunk never sent)
  // is ignored rather than trusted to open the window.
  ack(id: string, seq: number): void {
    const t = this.transfer;
    if (!t || t.id !== id || seq !== t.acked || seq >= t.sent) return;
    t.acked += 1;
    if (t.acked === t.chunks) {
      this.transfer = null;
      return;
    }
    this.pump();
  }

  cancel(id: string): void {
    if (this.latest === id) this.stop();
  }

  stop(): void {
    this.latest = null;
    this.transfer = null;
  }

  private pump(): void {
    const t = this.transfer;
    while (t && t.sent < t.chunks && t.sent - t.acked < MEDIA_WINDOW) {
      const start = t.sent * MEDIA_CHUNK_BYTES;
      const data = Buffer.from(t.bytes.subarray(start, start + MEDIA_CHUNK_BYTES)).toString('base64');
      this.send({ type: 'mediaChunk', id: t.id, seq: t.sent, data });
      t.sent += 1;
    }
  }
}

const RESULTS: Record<Exclude<ReadServableFileResult['kind'], 'ok'>, MediaResult> = {
  forbidden: 'forbidden',
  'not-servable': 'not-found',
  'too-large': 'too-large',
};
