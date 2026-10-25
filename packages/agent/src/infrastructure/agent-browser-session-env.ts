import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentBrowserSidecarDir } from './fs-browser-discovery';

export type SessionLaunchEnv = (session: string) => Promise<Record<string, string> | null>;

// Plumbing the CLI sets on the daemon it spawns, or that addresses another socket dir:
// replaying AGENT_BROWSER_DAEMON would turn the CLI itself into a daemon.
const NOT_REPLAYED = new Set([
  'AGENT_BROWSER_DAEMON',
  'AGENT_BROWSER_SESSION',
  'AGENT_BROWSER_STREAM_PORT',
  'AGENT_BROWSER_NAMESPACE',
  'AGENT_BROWSER_SOCKET_DIR',
]);

// The launch config a running agent-browser session was created with, read from its
// daemon's environment (`<session>.pid` → /proc/<pid>/environ). The CLI hands every launch
// setting to the daemon it spawns as AGENT_BROWSER_* variables, so replaying them makes a
// later command config-identical to the one that created the session. Null when there is
// no such daemon to read (a new session, a stale pid, a platform without /proc).
export function procSessionLaunchEnv(
  opts: { dir?: string; procRoot?: string } = {},
): SessionLaunchEnv {
  const dir = opts.dir ?? agentBrowserSidecarDir();
  const procRoot = opts.procRoot ?? '/proc';
  return async (session) => {
    if (session === '' || session.includes('/') || session.includes('..')) return null;
    let environ: string;
    try {
      const pid = (await readFile(join(dir, `${session}.pid`), 'utf8')).trim();
      if (!/^\d+$/.test(pid)) return null;
      environ = await readFile(join(procRoot, pid, 'environ'), 'utf8');
    } catch {
      return null;
    }
    const vars = new Map<string, string>();
    for (const entry of environ.split('\0')) {
      const eq = entry.indexOf('=');
      if (eq > 0) vars.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
    // A reused pid or a stale sidecar points at some other process.
    if (vars.get('AGENT_BROWSER_DAEMON') !== '1' || vars.get('AGENT_BROWSER_SESSION') !== session) {
      return null;
    }
    const env: Record<string, string> = {};
    for (const [name, value] of vars) {
      if ((name.startsWith('AGENT_BROWSER_') && !NOT_REPLAYED.has(name)) || name === 'DISPLAY') {
        env[name] = value;
      }
    }
    return env;
  };
}
