import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrowserCommandPort } from '../ports/browser-command-port';
import { procSessionLaunchEnv, type SessionLaunchEnv } from './agent-browser-session-env';
import { childEnv } from './child-env';

const exec = promisify(execFile);

export type CommandRunner = (
  cmd: string,
  args: string[],
  launchEnv: Record<string, string> | null,
) => Promise<void>;

// argv array, never a shell string — the URL must not reach a shell. The child gets the
// agent's env (PERCH_ variables aside): the agent runs as a service, and the child needs the
// inherited PATH to locate the agent-browser mise shim. A session's launch env replaces every
// inherited AGENT_BROWSER_* variable rather than extending them: one the session was created
// without would still change its config.
export const execFileRunner: CommandRunner = async (cmd, args, launchEnv) => {
  const env = childEnv();
  if (launchEnv) {
    for (const name of Object.keys(env)) {
      if (name.startsWith('AGENT_BROWSER_')) delete env[name];
    }
    Object.assign(env, launchEnv);
  }
  await exec(cmd, args, { env });
};

function isHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

// agent-browser relaunches a session's browser — dropping the current page, the live stream
// and, for a session on a persistent profile, the profile itself — whenever a command's launch
// config (headed, profile, executable, args, init scripts…) differs from the one the session
// was created with, and restarts its daemon when the idle timeout or a policy differs. So each
// command replays the session's own launch env, read from its daemon. Perch cannot impose a
// config of its own (it once set an idle timeout, which nuked every session created without
// one); a session with no daemon to read (Perch's own `start`) inherits the agent's env.
export class AgentBrowserCli implements BrowserCommandPort {
  constructor(
    private readonly run: CommandRunner = execFileRunner,
    private readonly launchEnv: SessionLaunchEnv = procSessionLaunchEnv(),
  ) {}

  private async agentBrowser(session: string, args: string[]): Promise<void> {
    await this.run('agent-browser', ['--session', session, ...args], await this.launchEnv(session));
  }

  async start(session: string): Promise<void> {
    await this.agentBrowser(session, ['open', 'about:blank']);
    await this.setPhoneViewport(session);
  }

  // A phone-sized viewport renders ~1:1 on the phone canvas, so taps land precisely
  // (a 1280px page scaled to a 390px screen needs sub-finger accuracy). Best-effort:
  // an older CLI without `set viewport` still yields a usable session.
  private async setPhoneViewport(session: string): Promise<void> {
    try {
      await this.agentBrowser(session, ['set', 'viewport', '390', '700']);
    } catch {
      // viewport is an enhancement, not a requirement
    }
  }

  async navigate(session: string, url: string): Promise<void> {
    if (!isHttpUrl(url)) {
      throw new Error(`refusing to open non-http(s) URL: ${url}`);
    }
    await this.agentBrowser(session, ['open', url]);
  }

  async back(session: string): Promise<void> {
    await this.agentBrowser(session, ['back']);
  }

  async forward(session: string): Promise<void> {
    await this.agentBrowser(session, ['forward']);
  }

  async stop(session: string): Promise<void> {
    await this.agentBrowser(session, ['close']);
  }

  async setViewport(session: string, width: number, height: number): Promise<void> {
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error('viewport dimensions must be finite');
    }
    const clamp = (n: number) => String(Math.min(4096, Math.max(200, Math.round(n))));
    await this.agentBrowser(session, ['set', 'viewport', clamp(width), clamp(height)]);
  }
}
