import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

export class CodexAppServerDown extends Error {
  constructor() {
    super('the Codex app server is not running');
  }
}

// An error answer from the daemon; its message is the daemon's own.
export class CodexRpcError extends Error {}

export interface CodexThreadState {
  status: 'idle' | 'active';
  activeTurnId?: string;
}

type Rpc = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };

// One JSON-RPC exchange over a WebSocket on the Codex app-server daemon's unix socket, opened and
// closed per call.
class Connection {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(msg: Rpc) => void>();
  private failure: Error | undefined;

  constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      let msg: Rpc;
      try {
        msg = JSON.parse(String(raw)) as Rpc;
      } catch {
        return;
      }
      const waiter = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (waiter) {
        this.pending.delete(msg.id!);
        if (msg.error) waiter.reject(new CodexRpcError(msg.error.message ?? 'unknown error'));
        else waiter.resolve(msg.result);
        return;
      }
      if (msg.method) for (const l of this.listeners) l(msg);
    });
    ws.on('close', () => this.fail(new Error('the Codex app server closed the connection')));
    ws.on('error', (err) => this.fail(err));
  }

  fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    for (const w of this.pending.values()) w.reject(err);
    this.pending.clear();
    for (const l of this.listeners) l({});
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: string): void {
    this.ws.send(JSON.stringify({ method }));
  }

  // Resolves on the first notification `match` accepts. Register it before sending what causes
  // the notification: the daemon may send it before the answer to that request.
  waitFor(match: (msg: Rpc) => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const listener = (msg: Rpc) => {
        if (this.failure) {
          this.listeners.delete(listener);
          reject(this.failure);
        } else if (match(msg)) {
          this.listeners.delete(listener);
          resolve();
        }
      };
      this.listeners.add(listener);
      if (this.failure) listener({});
    });
  }
}

export class CodexAppServer {
  readonly socketPath: string;
  readonly timeoutMs: number;

  constructor(options: { socketPath?: string; timeoutMs?: number } = {}) {
    this.socketPath = options.socketPath ?? join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock');
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  loadedThreads(): Promise<string[]> {
    return this.call(async (c) => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { data: string[]; nextCursor?: string | null } = await c.request('thread/loaded/list', cursor ? { cursor } : {});
        ids.push(...page.data);
        cursor = page.nextCursor ?? null;
      } while (cursor);
      return ids;
    });
  }

  threadState(threadId: string): Promise<CodexThreadState> {
    return this.call(async (c) => {
      const { thread } = await c.request<{ thread: { status: { type: string }; turns?: Array<{ id: string; status: string }> } }>(
        'thread/read',
        { threadId, includeTurns: true },
      );
      if (thread.status.type !== 'active') return { status: 'idle' };
      const running = [...(thread.turns ?? [])].reverse().find((t) => t.status === 'inProgress');
      return running ? { status: 'active', activeTurnId: running.id } : { status: 'active' };
    });
  }

  startTurn(threadId: string, text: string): Promise<void> {
    return this.call(async (c) => {
      await c.request('turn/start', { threadId, input: [{ type: 'text', text }] });
    });
  }

  steer(threadId: string, text: string, expectedTurnId: string): Promise<void> {
    return this.call(async (c) => {
      await c.request('turn/steer', { threadId, input: [{ type: 'text', text }], expectedTurnId });
    });
  }

  // A thread with no turn has no rollout: it vanishes when this connection closes, and
  // `codex resume` cannot find it. Its first turn writes the rollout (measured: on disk by the
  // time turn/start answers, a few ms before turn/started), so the connection stays open until
  // turn/started and no longer; the turn itself may run for hours.
  createThread(input: { cwd: string; model?: string; developerInstructions?: string; firstMessage: string }): Promise<string> {
    return this.call(async (c) => {
      const { thread } = await c.request<{ thread: { id: string } }>('thread/start', {
        cwd: input.cwd,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.developerInstructions !== undefined ? { developerInstructions: input.developerInstructions } : {}),
      });
      const started = c.waitFor(
        (m) => m.method === 'turn/started' && (m.params as { threadId?: unknown } | undefined)?.threadId === thread.id,
      );
      await Promise.all([started, c.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: input.firstMessage }] })]);
      return thread.id;
    });
  }

  private call<T>(run: (c: Connection) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ws = new WebSocket(`ws+unix://${this.socketPath}:/`, { perMessageDeflate: false });
      const c = new Connection(ws);
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
        ws.removeAllListeners('close');
        ws.on('error', () => undefined);
        ws.terminate();
      };
      const timer = setTimeout(() => {
        const err = new Error(`the Codex app server did not answer in ${this.timeoutMs / 1000} s`);
        c.fail(err);
        settle(() => reject(err));
      }, this.timeoutMs);
      ws.once('error', (err: NodeJS.ErrnoException) => {
        const down = err.code === 'ENOENT' || err.code === 'ECONNREFUSED';
        settle(() => reject(down ? new CodexAppServerDown() : err));
      });
      ws.once('close', () => settle(() => reject(new Error('the Codex app server closed the connection'))));
      ws.once('open', () => {
        c.request('initialize', { clientInfo: { name: 'perch-agent', version: '0.0.0' } })
          .then(() => {
            c.notify('initialized');
            return run(c);
          })
          .then(
            (value) => settle(() => resolve(value)),
            (err: Error) => settle(() => reject(err)),
          );
      });
    });
  }
}
