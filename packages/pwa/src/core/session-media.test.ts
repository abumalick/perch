import { describe, it, expect } from 'vitest';
import type { ClientMessage } from '@perch/contracts';
import { MAX_MEDIA_BYTES, SessionMedia } from './session-media';

function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

// jsdom's Blob has no arrayBuffer().
function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
}

function setup() {
  const sent: ClientMessage[] = [];
  const timers: Array<{ fn: () => void; live: boolean }> = [];
  let n = 0;
  const media = new SessionMedia({
    send: (m) => sent.push(m),
    newId: () => `m${(n += 1)}`,
    startTimer: (fn) => {
      const t = { fn, live: true };
      timers.push(t);
      return () => (t.live = false);
    },
  });
  const fireTimers = () => timers.filter((t) => t.live).forEach((t) => t.fn());
  return { sent, media, fireTimers };
}

describe('SessionMedia', () => {
  it('requests the file, acknowledges each chunk, and builds a Blob of the announced type', async () => {
    const { sent, media } = setup();
    const result = media.read('/p/a.png');
    expect(sent).toEqual([{ type: 'readMedia', id: 'm1', path: '/p/a.png' }]);
    media.handle({ type: 'media', id: 'm1', result: 'ok', mediaType: 'image/png', size: 5 });
    media.handle({ type: 'mediaChunk', id: 'm1', seq: 0, data: b64([1, 2, 3]) });
    media.handle({ type: 'mediaChunk', id: 'm1', seq: 1, data: b64([4, 5]) });
    const read = await result;
    if (read.result !== 'ok') throw new Error(`read failed: ${read.result}`);
    expect(read.blob.type).toBe('image/png');
    expect([...(await bytesOf(read.blob))]).toEqual([1, 2, 3, 4, 5]);
    expect(sent.slice(1)).toEqual([
      { type: 'mediaAck', id: 'm1', seq: 0 },
      { type: 'mediaAck', id: 'm1', seq: 1 },
    ]);
  });

  it.each(['forbidden', 'not-found', 'too-large', 'error'] as const)('answers %s as the agent put it, with no blob', async (result) => {
    const { media } = setup();
    const read = media.read('/p/a.png');
    media.handle({ type: 'media', id: 'm1', result });
    expect(await read).toEqual({ result });
  });

  it('resolves an empty file at once', async () => {
    const { media } = setup();
    const read = media.read('/p/a.png');
    media.handle({ type: 'media', id: 'm1', result: 'ok', mediaType: 'image/png', size: 0 });
    expect(await read).toEqual({ result: 'ok', blob: expect.objectContaining({ size: 0 }) });
  });

  it('refuses a file announced above the cap, and cancels it on the agent', async () => {
    const { sent, media } = setup();
    const read = media.read('/p/a.png');
    media.handle({ type: 'media', id: 'm1', result: 'ok', mediaType: 'image/png', size: MAX_MEDIA_BYTES + 1 });
    await expect(read).rejects.toThrow();
    expect(sent.at(-1)).toEqual({ type: 'mediaCancel', id: 'm1' });
  });

  it('refuses more bytes than announced, and chunks out of order', async () => {
    const { media } = setup();
    const over = media.read('/p/a.png');
    media.handle({ type: 'media', id: 'm1', result: 'ok', mediaType: 'image/png', size: 2 });
    media.handle({ type: 'mediaChunk', id: 'm1', seq: 0, data: b64([1, 2, 3]) });
    await expect(over).rejects.toThrow();

    const skipped = media.read('/p/b.png');
    media.handle({ type: 'media', id: 'm2', result: 'ok', mediaType: 'image/png', size: 4 });
    media.handle({ type: 'mediaChunk', id: 'm2', seq: 1, data: b64([1, 2]) });
    await expect(skipped).rejects.toThrow();
  });

  it('cancels the older read when a newer one starts, and ignores its late messages', async () => {
    const { sent, media } = setup();
    const first = media.read('/p/a.png');
    const second = media.read('/p/b.png');
    await expect(first).rejects.toThrow();
    expect(sent).toContainEqual({ type: 'mediaCancel', id: 'm1' });
    expect(media.handle({ type: 'media', id: 'm1', result: 'ok', mediaType: 'image/png', size: 1 })).toBe(true);
    media.handle({ type: 'media', id: 'm2', result: 'not-found' });
    expect(await second).toEqual({ result: 'not-found' });
  });

  it('fails the read when the machine goes offline, or when the transfer stalls', async () => {
    const { media, fireTimers } = setup();
    const dropped = media.read('/p/a.png');
    media.offline();
    await expect(dropped).rejects.toThrow();

    const stalled = media.read('/p/b.png');
    media.handle({ type: 'media', id: 'm2', result: 'ok', mediaType: 'image/png', size: 4 });
    fireTimers();
    await expect(stalled).rejects.toThrow();
  });

  it('leaves other messages alone', () => {
    const { media } = setup();
    expect(media.handle({ type: 'pong' })).toBe(false);
  });
});

describe('SessionMedia media type', () => {
  it('refuses a reply whose media type differs from the one the path implies', async () => {
    const { sent, media } = setup();
    const read = media.read('/p/report.pdf');
    media.handle({ type: 'media', id: 'm1', result: 'ok', mediaType: 'text/html', size: 3 });
    await expect(read).rejects.toThrow(/media type/);
    expect(sent.at(-1)).toEqual({ type: 'mediaCancel', id: 'm1' });
  });

  it('refuses a mismatched type even for an empty file, so no Blob of it is built', async () => {
    const { media } = setup();
    const read = media.read('/p/report.pdf');
    media.handle({ type: 'media', id: 'm1', result: 'ok', mediaType: 'image/svg+xml', size: 0 });
    await expect(read).rejects.toThrow(/media type/);
  });

  it('builds the Blob with the path-derived type when the agent names none', async () => {
    const { media } = setup();
    const read = media.read('/p/report.pdf');
    media.handle({ type: 'media', id: 'm1', result: 'ok', size: 1 });
    media.handle({ type: 'mediaChunk', id: 'm1', seq: 0, data: b64([37]) });
    const result = await read;
    if (result.result !== 'ok') throw new Error(result.result);
    expect(result.blob.type).toBe('application/pdf');
  });
});
