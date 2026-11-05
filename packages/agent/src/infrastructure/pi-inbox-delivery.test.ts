import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiInboxDelivery } from './pi-inbox-delivery';

// Under the repo's gitignored .tmp: a unix socket path must stay short, and tests keep out of /tmp.
const TMP_ROOT = fileURLToPath(new URL('../../../../.tmp', import.meta.url));

let dir: string;
let server: Server | undefined;
const sockets: Socket[] = [];

beforeEach(async () => {
  await mkdir(TMP_ROOT, { recursive: true });
  dir = await mkdtemp(join(TMP_ROOT, 'pi-'));
});

afterEach(async () => {
  vi.useRealTimers();
  for (const s of sockets) s.destroy();
  sockets.length = 0;
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

// Behaves like the Pi extension's inbox: reads one line, answers with `reply` (or runs `onLine`).
function listen(id: string, onLine: (line: string, socket: Socket) => void): Promise<void> {
  server = createServer((socket) => {
    sockets.push(socket);
    let buf = '';
    socket.on('data', (d) => {
      buf += String(d);
      const i = buf.indexOf('\n');
      if (i >= 0) onLine(buf.slice(0, i), socket);
    });
  });
  return new Promise((done) => server!.listen(join(dir, `${id}.sock`), () => done()));
}

const target = { id: 'perch-c', from: 'perch-p', cli: 'pi' as const, command: 'pi-reviewed' };

describe('PiInboxDelivery', () => {
  it('writes one {v:1,text} line to <dir>/<id>.sock and resolves ok on {"ok":true}', async () => {
    let received = '';
    await listen('perch-c', (line, socket) => {
      received = line;
      socket.end('{"ok":true}\n');
    });
    const text = '[Perch message — from a PEER]\nfrom: x\n---\nsay "hi"\nline two';
    expect(await new PiInboxDelivery(dir).deliver(target, text)).toEqual({ ok: true });
    expect(received).toBe(JSON.stringify({ v: 1, text }));
  });

  it('reports a missing socket as Pi without the Tarfa inbox', async () => {
    expect(await new PiInboxDelivery(dir).deliver(target, 'hi')).toEqual({ ok: false, reason: 'Pi without the Tarfa inbox' });
  });

  it('reports a stale socket file nobody listens on as Pi without the Tarfa inbox', async () => {
    await listen('perch-c', () => {});
    await new Promise<void>((done) => server!.close(() => done()));
    server = undefined;
    await writeFile(join(dir, 'perch-c.sock'), '');
    expect(await new PiInboxDelivery(dir).deliver(target, 'hi')).toEqual({ ok: false, reason: 'Pi without the Tarfa inbox' });
  });

  it('passes the inbox refusal through', async () => {
    await listen('perch-c', (_line, socket) => socket.end('{"ok":false,"error":"malformed message"}\n'));
    expect(await new PiInboxDelivery(dir).deliver(target, 'hi')).toEqual({
      ok: false,
      reason: 'the Pi inbox refused: malformed message',
    });
  });

  it('reads an answer whose multibyte character is split across two writes', async () => {
    await listen('perch-c', (_line, socket) => {
      const bytes = Buffer.from('{"ok":false,"error":"refusé — non"}\n', 'utf8');
      const cut = bytes.indexOf(Buffer.from('—', 'utf8')) + 1;
      socket.write(bytes.subarray(0, cut));
      setTimeout(() => socket.end(bytes.subarray(cut)), 20);
    });
    expect(await new PiInboxDelivery(dir).deliver(target, 'hi')).toEqual({
      ok: false,
      reason: 'the Pi inbox refused: refusé — non',
    });
  });

  it('fails when the inbox closes without answering', async () => {
    await listen('perch-c', (_line, socket) => socket.end());
    expect(await new PiInboxDelivery(dir).deliver(target, 'hi')).toEqual({
      ok: false,
      reason: 'the Pi inbox of perch-c failed: closed without answering',
    });
  });

  it('fails on an answer that is not the contract', async () => {
    await listen('perch-c', (_line, socket) => socket.end('nope\n'));
    expect(await new PiInboxDelivery(dir).deliver(target, 'hi')).toEqual({
      ok: false,
      reason: 'the Pi inbox of perch-c failed: unexpected answer',
    });
  });

  it('refuses a workspace id that is not a plain file name', async () => {
    expect(await new PiInboxDelivery(dir).deliver({ ...target, id: '../x' }, 'hi')).toEqual({
      ok: false,
      reason: 'the Pi inbox of ../x failed: not a workspace id',
    });
  });

  it('times out at 5 s when the inbox never answers', async () => {
    let connected!: () => void;
    const accepted = new Promise<void>((r) => (connected = r));
    await listen('perch-c', () => connected());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = new PiInboxDelivery(dir).deliver(target, 'hi');
    await accepted;
    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, reason: 'the Pi inbox did not answer in 5 s' });
  });
});
