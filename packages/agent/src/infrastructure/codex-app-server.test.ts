import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { CodexAppServer, CodexAppServerDown, CodexRpcError } from './codex-app-server';

// Under the repo's gitignored .tmp: a unix socket path must stay short, and tests keep out of /tmp.
const TMP_ROOT = fileURLToPath(new URL('../../../../.tmp', import.meta.url));

type Msg = { id?: number; method?: string; params?: Record<string, unknown> };
type Handler = (msg: Msg, ws: WebSocket) => void;

let dir: string;
let socketPath: string;
let http: Server | undefined;
let wss: WebSocketServer | undefined;
let received: Msg[][];

beforeEach(async () => {
  await mkdir(TMP_ROOT, { recursive: true });
  dir = await mkdtemp(join(TMP_ROOT, 'cx-'));
  socketPath = join(dir, 's.sock');
  received = [];
});

afterEach(async () => {
  for (const c of wss?.clients ?? []) c.terminate();
  await new Promise<void>((done) => (wss ? wss.close(() => done()) : done()));
  await new Promise<void>((done) => (http ? http.close(() => done()) : done()));
  wss = undefined;
  http = undefined;
  await rm(dir, { recursive: true, force: true });
});

const reply = (ws: WebSocket, id: number | undefined, result: unknown) => ws.send(JSON.stringify({ id, result }));
const fail = (ws: WebSocket, id: number | undefined, message: string) =>
  ws.send(JSON.stringify({ id, error: { code: -32600, message } }));
const notify = (ws: WebSocket, method: string, params: unknown) => ws.send(JSON.stringify({ method, params }));

// A daemon that answers `initialize` like Codex's and hands every later request to `handle`.
function daemon(handle: Record<string, Handler>): Promise<void> {
  http = createServer();
  wss = new WebSocketServer({ server: http });
  wss.on('connection', (ws) => {
    const log: Msg[] = [];
    received.push(log);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as Msg;
      log.push(msg);
      if (msg.method === 'initialize') return reply(ws, msg.id, { userAgent: 'codex' });
      const h = msg.method ? handle[msg.method] : undefined;
      if (h) h(msg, ws);
    });
  });
  return new Promise((done) => http!.listen(socketPath, () => done()));
}

const server = (timeoutMs?: number) => new CodexAppServer({ socketPath, ...(timeoutMs ? { timeoutMs } : {}) });

describe('CodexAppServer', () => {
  it('initializes as tarfa-agent, sends initialized, then the request', async () => {
    await daemon({ 'thread/loaded/list': (m, ws) => reply(ws, m.id, { data: ['t1'], nextCursor: null }) });
    expect(await server().loadedThreads()).toEqual(['t1']);
    const [init, initialized, request] = received[0]!;
    expect(init).toMatchObject({ method: 'initialize', params: { clientInfo: { name: 'tarfa-agent' } } });
    expect(initialized).toEqual({ method: 'initialized' });
    expect(request).toMatchObject({ method: 'thread/loaded/list' });
  });

  it('follows nextCursor through every page of loaded threads', async () => {
    await daemon({
      'thread/loaded/list': (m, ws) =>
        m.params?.cursor === 'c2'
          ? reply(ws, m.id, { data: ['t3'], nextCursor: null })
          : reply(ws, m.id, { data: ['t1', 't2'], nextCursor: 'c2' }),
    });
    expect(await server().loadedThreads()).toEqual(['t1', 't2', 't3']);
  });

  it('opens one connection per call', async () => {
    await daemon({ 'thread/loaded/list': (m, ws) => reply(ws, m.id, { data: [], nextCursor: null }) });
    await server().loadedThreads();
    await server().loadedThreads();
    expect(received).toHaveLength(2);
  });

  it('reads an active thread with the id of its in-progress turn', async () => {
    await daemon({
      'thread/read': (m, ws) =>
        reply(ws, m.id, {
          thread: {
            id: 't1',
            status: { type: 'active', activeFlags: [] },
            turns: [
              { id: 'u1', status: 'completed' },
              { id: 'u2', status: 'inProgress' },
            ],
          },
        }),
    });
    expect(await server().threadState('t1')).toEqual({ status: 'active', activeTurnId: 'u2' });
    expect(received[0]![2]).toMatchObject({ method: 'thread/read', params: { threadId: 't1', includeTurns: true } });
  });

  it('reads an idle thread', async () => {
    await daemon({
      'thread/read': (m, ws) => reply(ws, m.id, { thread: { id: 't1', status: { type: 'idle' }, turns: [{ id: 'u1', status: 'completed' }] } }),
    });
    expect(await server().threadState('t1')).toEqual({ status: 'idle' });
  });

  it('starts a turn with the text as its input', async () => {
    await daemon({ 'turn/start': (m, ws) => reply(ws, m.id, { turn: { id: 'u1', status: 'inProgress' } }) });
    await server().startTurn('t1', 'hello');
    expect(received[0]![2]).toMatchObject({
      method: 'turn/start',
      params: { threadId: 't1', input: [{ type: 'text', text: 'hello' }] },
    });
  });

  it('steers the running turn it names', async () => {
    await daemon({ 'turn/steer': (m, ws) => reply(ws, m.id, { turnId: 'u2' }) });
    await server().steer('t1', 'hello', 'u2');
    expect(received[0]![2]).toMatchObject({
      method: 'turn/steer',
      params: { threadId: 't1', input: [{ type: 'text', text: 'hello' }], expectedTurnId: 'u2' },
    });
  });

  it('rejects with the daemon error message', async () => {
    await daemon({ 'turn/steer': (m, ws) => fail(ws, m.id, 'no active turn to steer') });
    const err = await server().steer('t1', 'x', 'u2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodexRpcError);
    expect((err as Error).message).toBe('no active turn to steer');
  });

  it('rejects a missing socket as a daemon that is not running', async () => {
    const err = await server().loadedThreads().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodexAppServerDown);
  });

  it('rejects when the daemon does not answer in time', async () => {
    await daemon({});
    const started = Date.now();
    const err = await server(100).loadedThreads().catch((e: unknown) => e);
    expect((err as Error).message).toBe('the Codex app server did not answer in 0.1 s');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('defaults to a 5 s deadline', () => {
    expect(new CodexAppServer({ socketPath }).timeoutMs).toBe(5_000);
  });

  describe('createThread', () => {
    it('starts the thread and its first turn on one connection, and resolves once the turn has started', async () => {
      let ws!: WebSocket;
      await daemon({
        'thread/start': (m, s) => reply(s, m.id, { thread: { id: 't9', status: { type: 'idle' }, turns: [] } }),
        'turn/start': (m, s) => {
          ws = s;
          reply(s, m.id, { turn: { id: 'u1', status: 'inProgress' } });
        },
      });
      let resolved: string | undefined;
      const pending = server().createThread({ cwd: '/w', model: 'm', developerInstructions: 'be brief', firstMessage: 'go' });
      void pending.then((id) => (resolved = id));
      await until(() => ws !== undefined);
      await new Promise((r) => setTimeout(r, 50));
      expect(resolved).toBeUndefined();
      notify(ws, 'turn/started', { threadId: 'other', turn: { id: 'x' } });
      await new Promise((r) => setTimeout(r, 50));
      expect(resolved).toBeUndefined();
      notify(ws, 'turn/started', { threadId: 't9', turn: { id: 'u1' } });
      expect(await pending).toBe('t9');
      expect(received).toHaveLength(1);
      const [, , start, turn] = received[0]!;
      expect(start).toMatchObject({ method: 'thread/start', params: { cwd: '/w', model: 'm', developerInstructions: 'be brief' } });
      expect(turn).toMatchObject({ method: 'turn/start', params: { threadId: 't9', input: [{ type: 'text', text: 'go' }] } });
    });

    it('resolves when turn/started arrives before the turn/start answer', async () => {
      await daemon({
        'thread/start': (m, s) => reply(s, m.id, { thread: { id: 't9' } }),
        'turn/start': (m, s) => {
          notify(s, 'turn/started', { threadId: 't9', turn: { id: 'u1' } });
          reply(s, m.id, { turn: { id: 'u1', status: 'inProgress' } });
        },
      });
      expect(await server().createThread({ cwd: '/w', firstMessage: 'go' })).toBe('t9');
    });

    it('sends no model or instructions it was not given', async () => {
      await daemon({
        'thread/start': (m, s) => reply(s, m.id, { thread: { id: 't9' } }),
        'turn/start': (m, s) => {
          reply(s, m.id, { turn: { id: 'u1', status: 'inProgress' } });
          notify(s, 'turn/started', { threadId: 't9', turn: { id: 'u1' } });
        },
      });
      await server().createThread({ cwd: '/w', firstMessage: 'go' });
      expect(received[0]![2]!.params).toEqual({ cwd: '/w' });
    });

    it('rejects when the first turn is refused', async () => {
      await daemon({
        'thread/start': (m, s) => reply(s, m.id, { thread: { id: 't9' } }),
        'turn/start': (m, s) => fail(s, m.id, 'quota'),
      });
      await expect(server().createThread({ cwd: '/w', firstMessage: 'go' })).rejects.toThrow('quota');
    });

    it('rejects when the turn never starts', async () => {
      await daemon({
        'thread/start': (m, s) => reply(s, m.id, { thread: { id: 't9' } }),
        'turn/start': (m, s) => reply(s, m.id, { turn: { id: 'u1', status: 'inProgress' } }),
      });
      await expect(server(100).createThread({ cwd: '/w', firstMessage: 'go' })).rejects.toThrow('did not answer');
    });
  });
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
}
