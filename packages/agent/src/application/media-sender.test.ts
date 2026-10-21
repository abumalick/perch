import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@perch/contracts';
import { MEDIA_CHUNK_BYTES, MEDIA_WINDOW, MediaSender } from './media-sender';
import type { ReadServableFileResult } from './read-servable-file';

type Chunk = Extract<AgentMessage, { type: 'mediaChunk' }>;

function setup() {
  const sent: AgentMessage[] = [];
  const sender = new MediaSender((m) => sent.push(m));
  const chunks = () => sent.filter((m): m is Chunk => m.type === 'mediaChunk');
  return { sent, sender, chunks };
}

const ok = (size: number): ReadServableFileResult => ({
  kind: 'ok',
  mediaType: 'image/png',
  bytes: new Uint8Array(size).map((_, i) => i % 251),
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('MediaSender', () => {
  it('announces the file, then sends only a window of chunks until they are acknowledged', async () => {
    const { sent, sender, chunks } = setup();
    const size = MEDIA_CHUNK_BYTES * (MEDIA_WINDOW + 2) + 10;
    await sender.request('m1', async () => ok(size));

    expect(sent[0]).toEqual({ type: 'media', id: 'm1', result: 'ok', mediaType: 'image/png', size });
    expect(chunks().map((c) => c.seq)).toEqual([...Array(MEDIA_WINDOW).keys()]);

    sender.ack('m1', 0);
    expect(chunks()).toHaveLength(MEDIA_WINDOW + 1);
    sender.ack('m1', 1);
    sender.ack('m1', 2);
    expect(chunks()).toHaveLength(MEDIA_WINDOW + 3);
    sender.ack('m1', 3);
    expect(chunks()).toHaveLength(MEDIA_WINDOW + 3);
  });

  it('sends every byte, in order, each chunk small enough for one Noise frame', async () => {
    const { sender, chunks } = setup();
    const file = ok(MEDIA_CHUNK_BYTES * 3 + 7);
    await sender.request('m1', async () => file);
    for (let seq = 0; seq < 4; seq += 1) sender.ack('m1', seq);

    const bytes = Buffer.concat(chunks().map((c) => Buffer.from(c.data, 'base64')));
    expect(new Uint8Array(bytes)).toEqual((file as { bytes: Uint8Array }).bytes);
    for (const c of chunks()) {
      expect(new TextEncoder().encode(JSON.stringify(c)).length).toBeLessThan(65_519);
    }
  });

  it('announces an empty file with no chunks', async () => {
    const { sent, sender, chunks } = setup();
    await sender.request('m1', async () => ok(0));
    expect(sent).toEqual([{ type: 'media', id: 'm1', result: 'ok', mediaType: 'image/png', size: 0 }]);
    expect(chunks()).toEqual([]);
  });

  it.each([
    [{ kind: 'forbidden' } as const, 'forbidden'],
    [{ kind: 'not-servable' } as const, 'not-found'],
    [{ kind: 'too-large' } as const, 'too-large'],
  ])('reports %o as %s with nothing else', async (result, expected) => {
    const { sent, sender } = setup();
    await sender.request('m1', async () => result);
    expect(sent).toEqual([{ type: 'media', id: 'm1', result: expected }]);
  });

  it('reports a missing file as not-found and any other failure as error', async () => {
    const { sent, sender } = setup();
    await sender.request('m1', async () => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    });
    await sender.request('m2', async () => {
      throw new Error('boom');
    });
    expect(sent).toEqual([
      { type: 'media', id: 'm1', result: 'not-found' },
      { type: 'media', id: 'm2', result: 'error' },
    ]);
  });

  it('ignores acknowledgements for other ids, out of order, repeated, or for chunks not yet sent', async () => {
    const { sender, chunks } = setup();
    await sender.request('m1', async () => ok(MEDIA_CHUNK_BYTES * (MEDIA_WINDOW + 3)));
    sender.ack('other', 0);
    sender.ack('m1', 2);
    sender.ack('m1', MEDIA_WINDOW + 1);
    expect(chunks()).toHaveLength(MEDIA_WINDOW);
    sender.ack('m1', 0);
    sender.ack('m1', 0);
    expect(chunks()).toHaveLength(MEDIA_WINDOW + 1);
  });

  it('drops the transfer on cancel, and a newer request supersedes an older one', async () => {
    const { sender, chunks } = setup();
    await sender.request('m1', async () => ok(MEDIA_CHUNK_BYTES * (MEDIA_WINDOW + 2)));
    sender.cancel('m1');
    sender.ack('m1', 0);
    expect(chunks()).toHaveLength(MEDIA_WINDOW);

    await sender.request('m2', async () => ok(MEDIA_CHUNK_BYTES * (MEDIA_WINDOW + 2)));
    await sender.request('m3', async () => ok(1));
    sender.ack('m2', 0);
    expect(chunks().filter((c) => c.id === 'm2')).toHaveLength(MEDIA_WINDOW);
    expect(chunks().filter((c) => c.id === 'm3')).toHaveLength(1);
  });

  it('never answers a request superseded while its file was still being read', async () => {
    const { sent, sender } = setup();
    const slow = deferred<ReadServableFileResult>();
    const first = sender.request('m1', () => slow.promise);
    await sender.request('m2', async () => ok(1));
    slow.resolve(ok(1));
    await first;
    expect(sent.map((m) => (m as { id: string }).id)).toEqual(['m2', 'm2']);
  });

  it('stops sending once stopped', async () => {
    const { sender, chunks } = setup();
    await sender.request('m1', async () => ok(MEDIA_CHUNK_BYTES * (MEDIA_WINDOW + 2)));
    sender.stop();
    sender.ack('m1', 0);
    expect(chunks()).toHaveLength(MEDIA_WINDOW);
  });
});
