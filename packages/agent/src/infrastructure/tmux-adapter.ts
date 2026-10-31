import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TmuxPort, TmuxSessionInfo } from '../ports/tmux-port';
import { childEnv } from './child-env';

const exec = promisify(execFile);

// Every tmux call the agent makes. One that finds no server starts it, and the server keeps the
// env it was started with as every pane's: see childEnv.
export const tmux = (args: string[]) => exec('tmux', args, { env: childEnv() });

// Field separator for `list-sessions -F`. It must be PRINTABLE ASCII: when the agent
// runs as a service (launchd/systemd) its tmux client has no controlling TTY, and in
// that mode tmux rewrites every control character (tab, newline, …) and every
// non-ASCII byte in format output to `_`. A tab separator silently collapsed, so every
// line parsed as a single field and listSessions returned nothing. `|:|` survives that
// rewrite and is vanishingly unlikely to occur in a session name, path, or command.
// pane_title is last so it can contain the separator harmlessly (it's the remainder).
const SEP = '|:|';
const FORMAT = [
  '#{session_name}',
  '#{session_path}',
  '#{session_created}',
  '#{@perch_command}',
  '#{@perch_parent}',
  '#{pane_title}',
].join(SEP);

export function isNoServer(err: unknown): boolean {
  const stderr = (err as { stderr?: string }).stderr ?? '';
  // "no server running on <socket>" — the socket exists but the server is down.
  // "error connecting to <socket> (No such file or directory)" — the socket itself is
  // gone, which is what happens on a cold boot: /tmp is wiped before any tmux ran. Both
  // mean there is no server, hence no sessions; missing this second form crash-looped the
  // agent on startup after every reboot.
  return stderr.includes('no server running') || stderr.includes('error connecting to');
}

export function isMissingSession(err: unknown): boolean {
  const stderr = (err as { stderr?: string }).stderr ?? '';
  // `list-panes -t <session>` resolves its target as a window, so it reports an absent
  // session as a missing *window* — a different message for the same "target is gone".
  // tmux 3.6 says only "no current target" when the server is up but holds no session at
  // all, as one kept alive by a service is once its last workspace has gone.
  return (
    isNoServer(err) ||
    stderr.includes("can't find session") ||
    stderr.includes("can't find window") ||
    stderr.includes('no current target')
  );
}

function parseLine(line: string): TmuxSessionInfo | null {
  const parts = line.split(SEP);
  if (parts.length < 3) return null;
  const [name, startPath, created, command, parent] = parts;
  if (!name || !startPath || !created) return null;
  return {
    name,
    startPath,
    command: command ?? '',
    createdAt: Number(created) * 1000,
    ...(parent ? { parent } : {}),
    title: parts.slice(5).join(SEP),
  };
}

export interface TmuxAdapterOptions {
  // An explicit server socket (`-S`) for every call; tests use one so they never reach the
  // ambient server, which `$TMUX` would otherwise select.
  socket?: string;
  // A config file for a server this adapter starts (`-f`); a test server must not load the
  // user's ~/.tmux.conf, whose plugins (resurrect, continuum) act on the user's sessions.
  config?: string;
  // The environment child processes get, through childEnv. Defaults to process.env.
  env?: NodeJS.ProcessEnv;
}

export class TmuxAdapter implements TmuxPort {
  private readonly tmux: (args: string[]) => Promise<{ stdout: string; stderr: string }>;

  constructor(options: TmuxAdapterOptions = {}) {
    const prefix = [
      ...(options.socket ? ['-S', options.socket] : []),
      ...(options.config ? ['-f', options.config] : []),
    ];
    this.tmux = prefix.length === 0 && !options.env
      ? tmux
      : (args) => exec('tmux', [...prefix, ...args], { env: childEnv(options.env) });
  }

  // tmux's default terminal-features for xterm* lacks `hyperlinks`, so it strips OSC 8
  // links before streaming them to the agent's `attach-session` client. Append the
  // feature (server-global, persists for the tmux server's life). The show-check both
  // avoids a duplicate entry and makes this self-healing — run on every attach, it
  // re-adds the feature if anything (another tool, a config reload) ever cleared it,
  // rather than latching once and never recovering.
  async ensureHyperlinks(): Promise<void> {
    try {
      const { stdout } = await this.tmux(['show', '-g', 'terminal-features']);
      if (!stdout.includes('hyperlinks')) {
        await this.tmux(['set', '-as', 'terminal-features', '*:hyperlinks']);
      }
    } catch (err) {
      if (isNoServer(err)) return; // no server yet — a later attach retries
      throw err;
    }
  }

  async listSessions(prefix: string): Promise<TmuxSessionInfo[]> {
    let stdout: string;
    try {
      const res = await this.tmux(['list-sessions', '-F', FORMAT]);
      stdout = res.stdout;
    } catch (err) {
      if (isNoServer(err)) return [];
      throw err;
    }
    return stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map(parseLine)
      .filter((s): s is TmuxSessionInfo => s !== null && s.name.startsWith(prefix));
  }

  async createSession(input: { name: string; cwd: string; command: string; parent?: string; storedCommand?: string }): Promise<void> {
    await this.tmux(['new-session', '-d', '-s', input.name, '-c', input.cwd, input.command]);
    await this.tmux(['set-option', '-t', input.name, '@perch_command', input.storedCommand ?? input.command]);
    if (input.parent) await this.tmux(['set-option', '-t', input.name, '@perch_parent', input.parent]);
  }

  async killSession(name: string): Promise<void> {
    // Idempotent: when the inner process exits, tmux destroys the session on its own, so a
    // later close finds nothing to kill. Treat an already-absent session as success.
    try {
      await this.tmux(['kill-session', '-t', name]);
    } catch (err) {
      if (isMissingSession(err)) return;
      throw err;
    }
  }

  async panePid(name: string): Promise<number | null> {
    let stdout: string;
    try {
      const res = await this.tmux(['list-panes', '-t', name, '-F', '#{pane_pid}']);
      stdout = res.stdout;
    } catch (err) {
      if (isMissingSession(err)) return null;
      throw err;
    }
    const pid = Number(stdout.split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  async serverId(): Promise<string | null> {
    try {
      // display-message, not list-sessions: a server kept alive with no session left still
      // answers it, so the last workspace exiting does not read as the server going away.
      const { stdout } = await this.tmux(['display-message', '-p', '#{pid}:#{start_time}']);
      return stdout.trim() || null;
    } catch (err) {
      if (isNoServer(err)) return null;
      throw err;
    }
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.tmux(['has-session', '-t', name]);
      return true;
    } catch {
      return false;
    }
  }

  async setPaneTitle(name: string, title: string): Promise<void> {
    await this.tmux(['select-pane', '-t', name, '-T', title]);
  }

  async capturePane(name: string, historyLines: number): Promise<string> {
    const { stdout } = await this.tmux(['capture-pane', '-p', '-J', '-t', name, '-S', `-${historyLines}`]);
    return stdout;
  }

  async sessionOfPane(paneId: string): Promise<string | null> {
    try {
      // Targeted: an untargeted display-message answers for the most recently active session.
      const { stdout } = await this.tmux(['display-message', '-p', '-t', paneId, '#S']);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
}
