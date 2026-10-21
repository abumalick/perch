import { z } from 'zod';
import { clientLogBatchSchema } from './client-log';

// The side channels that ride the machine's own connection instead of a second HTTP request
// or socket: media previews, the browser view and the connection-log flush. Through a relay
// that connection is the end-to-end Noise session, so nothing leaves it in plaintext and the
// token never has to authenticate anything the relay can see.

// Ids are chosen by the PWA to match replies to requests; bounded so a peer cannot make the
// other side hold arbitrarily long keys.
const id = z.string().min(1).max(64);

// Media: one file read at a time per connection, sent as `mediaChunk`s of at most one Noise
// frame each, released by the PWA's `mediaAck`s so only a small window is ever in flight.
const mediaResultSchema = z.enum(['ok', 'forbidden', 'not-found', 'too-large', 'error']);
export type MediaResult = z.infer<typeof mediaResultSchema>;

export const sessionClientMessageSchemas = [
  z.object({ type: z.literal('readMedia'), id, path: z.string() }),
  z.object({ type: z.literal('mediaAck'), id, seq: z.number().int().nonnegative() }),
  z.object({ type: z.literal('mediaCancel'), id }),
  // A browser view: `data` is one message of the browser stream protocol (browser-messages.ts)
  // as JSON text. Each `browser` the agent sends
  // is acknowledged with a `browserAck`, which is what lets the agent drop stale frames for a
  // slow phone (see BrowserStreamHandler).
  z.object({ type: z.literal('browserOpen'), stream: id, session: z.string() }),
  z.object({ type: z.literal('browser'), stream: id, data: z.string() }),
  z.object({ type: z.literal('browserAck'), stream: id }),
  z.object({ type: z.literal('browserClose'), stream: id }),
  z.object({ type: z.literal('clientLog'), id, batch: clientLogBatchSchema }),
] as const;

export const sessionAgentMessageSchemas = [
  // The answer to `readMedia`. `size` and `mediaType` come with `ok`; `size` bytes then follow
  // as chunks numbered from 0.
  z.object({
    type: z.literal('media'),
    id,
    result: mediaResultSchema,
    mediaType: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal('mediaChunk'), id, seq: z.number().int().nonnegative(), data: z.string() }),
  z.object({ type: z.literal('browser'), stream: id, data: z.string() }),
  // The agent ended the stream (the session closed, was taken over, or never existed); the
  // reason, when there is one, came just before as a browser-protocol `ended`.
  z.object({ type: z.literal('browserClosed'), stream: id }),
  z.object({ type: z.literal('clientLogAck'), id, ok: z.boolean() }),
] as const;
