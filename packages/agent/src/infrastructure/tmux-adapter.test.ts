import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { TmuxAdapter, isMissingSession, isNoServer, tmux } from './tmux-adapter';

const exec = promisify(execFile);
const PREFIX = 'perch-test-';
const created: string[] = [];

afterEach(async () => {
  for (const name of created.splice(0)) {
    await exec('tmux', ['kill-session', '-t', name]).catch(() => undefined);
  }
});

describe('isNoServer', () => {
  it('recognizes the running-but-empty server message', () => {
    expect(isNoServer({ stderr: 'no server running on /tmp/tmux-1000/default\n' })).toBe(true);
  });

  it('recognizes the cold-boot missing-socket message', () => {
    // After a reboot /tmp is wiped, so the socket does not exist and tmux reports a
    // connection error rather than "no server running". Both mean: no sessions to list.
    expect(
      isNoServer({
        stderr: 'error connecting to /tmp/tmux-1000/default (No such file or directory)\n',
      }),
    ).toBe(true);
  });

  it('does not swallow unrelated tmux errors', () => {
    expect(isNoServer({ stderr: "can't find session: perch-foo\n" })).toBe(false);
    expect(isNoServer({})).toBe(false);
  });
});

describe('isMissingSession', () => {
  it('recognizes an absent target on a server with no sessions at all', () => {
    // tmux 3.6 cannot name the target it failed to resolve when the server has no session
    // left, and says only this instead of "can't find session".
    expect(isMissingSession({ stderr: 'no current target\n' })).toBe(true);
  });

  it('recognizes an absent session or window', () => {
    expect(isMissingSession({ stderr: "can't find session: perch-foo\n" })).toBe(true);
    expect(isMissingSession({ stderr: "can't find window: perch-foo\n" })).toBe(true);
  });

  it('does not swallow unrelated tmux errors', () => {
    expect(isMissingSession({ stderr: 'unknown option -- z\n' })).toBe(false);
  });
});

describe('TmuxAdapter (real tmux)', () => {
  it('creates, lists, and kills a session', async () => {
    const adapter = new TmuxAdapter();
    const name = `${PREFIX}${Date.now()}`;
    created.push(name);

    await adapter.createSession({ name, cwd: tmpdir(), command: 'sleep 30' });
    expect(await adapter.hasSession(name)).toBe(true);

    const sessions = await adapter.listSessions(PREFIX);
    const found = sessions.find((s) => s.name === name);
    expect(found).toBeDefined();
    expect(found?.command).toBe('sleep 30');
    expect(found?.createdAt).toBeGreaterThan(1_000_000_000_000); // epoch ms, not seconds

    await adapter.killSession(name);
    expect(await adapter.hasSession(name)).toBe(false);
  });

  it('treats killing an already-absent session as success', async () => {
    // When the inner process (e.g. Claude) exits, tmux destroys the session on its own.
    // A later close request must not error on the vanished session — close is idempotent.
    const adapter = new TmuxAdapter();
    await expect(adapter.killSession(`${PREFIX}does-not-exist`)).resolves.toBeUndefined();
  });

  it('reads the live pane title of a session', async () => {
    const adapter = new TmuxAdapter();
    const name = `${PREFIX}${Date.now()}-title`;
    created.push(name);
    await adapter.createSession({ name, cwd: tmpdir(), command: 'sleep 30' });
    await exec('tmux', ['select-pane', '-t', name, '-T', '✳ live title']);

    const sessions = await adapter.listSessions(PREFIX);
    expect(sessions.find((s) => s.name === name)?.title).toBe('✳ live title');
  });

  it('parses a pane title that contains the field separator', async () => {
    // pane_title is the last field, so a separator inside it must round-trip intact
    // rather than truncate the title or shift fields.
    const adapter = new TmuxAdapter();
    const name = `${PREFIX}${Date.now()}-sep`;
    created.push(name);
    await adapter.createSession({ name, cwd: tmpdir(), command: 'sleep 30' });
    await exec('tmux', ['select-pane', '-t', name, '-T', 'a|:|b|:|c']);

    const sessions = await adapter.listSessions(PREFIX);
    expect(sessions.find((s) => s.name === name)?.title).toBe('a|:|b|:|c');
  });

  it('enables the hyperlinks terminal-feature, idempotently', async () => {
    // Needs a running tmux server for `show`/`set` to apply; create a throwaway session.
    const name = `${PREFIX}${Date.now()}-hl`;
    created.push(name);
    const adapter = new TmuxAdapter();
    await adapter.createSession({ name, cwd: tmpdir(), command: 'sleep 30' });

    await adapter.ensureHyperlinks();
    const after = (await exec('tmux', ['show', '-g', 'terminal-features'])).stdout;
    expect(after).toContain('hyperlinks');

    // Self-healing on every call, but the show-check must not add a duplicate entry.
    await adapter.ensureHyperlinks();
    const occurrences = (await exec('tmux', ['show', '-g', 'terminal-features'])).stdout.match(
      /hyperlinks/g,
    );
    expect(occurrences?.length).toBe(1);
  });

  it('reads the pid of a session pane', async () => {
    const adapter = new TmuxAdapter();
    const name = `${PREFIX}${Date.now()}-pid`;
    created.push(name);
    await adapter.createSession({ name, cwd: tmpdir(), command: 'sleep 30' });

    const pid = await adapter.panePid(name);
    expect(pid).toBeGreaterThan(0);
    // The pid must be a real live process, not a parsed-out NaN or a stale number.
    expect(() => process.kill(pid!, 0)).not.toThrow();
  });

  it('returns null for the pane pid of an absent session', async () => {
    // The close path asks for the pid of a session that may already be gone (the inner
    // process exited on its own); that is an answer, not an error.
    const adapter = new TmuxAdapter();
    await expect(adapter.panePid(`${PREFIX}does-not-exist`)).resolves.toBeNull();
  });

  it('identifies the running server by its pid and start time', async () => {
    const adapter = new TmuxAdapter();
    const name = `${PREFIX}${Date.now()}-server`;
    created.push(name);
    await adapter.createSession({ name, cwd: tmpdir(), command: 'sleep 30' });
    const id = await adapter.serverId();
    expect(id).toMatch(/^\d+:\d+$/);
    expect(await adapter.serverId()).toBe(id);
  });

  it('returns sessions filtered by prefix', async () => {
    const adapter = new TmuxAdapter();
    const name = `${PREFIX}${Date.now()}-x`;
    created.push(name);
    await adapter.createSession({ name, cwd: tmpdir(), command: 'sleep 30' });

    const sessions = await adapter.listSessions('perch-nonexistent-');
    expect(sessions.every((s) => s.name.startsWith('perch-nonexistent-'))).toBe(true);
    expect(sessions.find((s) => s.name === name)).toBeUndefined();
  });
});

// A tmux server copies the environment of the client that starts it into its global
// environment, which every pane inherits. When the agent's own `new-session` starts the server,
// that client must not carry the agent's secrets. Run on a private socket: the shared server
// is never touched.
describe('tmux (the agent\'s tmux client)', () => {
  it('starts a server whose global environment holds no PERCH_ variable', async () => {
    const socket = `perch-env-test-${process.pid}-${Date.now()}`;
    const saved = process.env.PERCH_TOKEN;
    process.env.PERCH_TOKEN = 'leaked-token';
    try {
      await tmux(['-L', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'probe', '-c', tmpdir(), 'sleep 30']);
      const { stdout } = await exec('tmux', ['-L', socket, 'show-environment', '-g']);
      expect(stdout).toContain('PATH=');
      expect(stdout).not.toContain('PERCH_');
    } finally {
      if (saved === undefined) delete process.env.PERCH_TOKEN;
      else process.env.PERCH_TOKEN = saved;
      await exec('tmux', ['-L', socket, 'kill-server']).catch(() => undefined);
    }
  });
});
