import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { procSessionLaunchEnv } from './agent-browser-session-env';

describe('procSessionLaunchEnv', () => {
  let root: string;
  let dir: string;
  let procRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'perch-ab-env-'));
    dir = join(root, 'agent-browser');
    procRoot = join(root, 'proc');
    await mkdir(dir);
    await mkdir(procRoot);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function daemon(session: string, pid: number, env: Record<string, string>) {
    await writeFile(join(dir, `${session}.pid`), `${pid}\n`);
    await mkdir(join(procRoot, String(pid)));
    const environ = Object.entries(env)
      .map(([k, v]) => `${k}=${v}\0`)
      .join('');
    await writeFile(join(procRoot, String(pid), 'environ'), environ);
  }

  it("returns the daemon's AGENT_BROWSER_* settings and DISPLAY, minus its plumbing", async () => {
    await daemon('ws__g', 42, {
      AGENT_BROWSER_DAEMON: '1',
      AGENT_BROWSER_SESSION: 'ws__g',
      AGENT_BROWSER_STREAM_PORT: '9000',
      AGENT_BROWSER_NAMESPACE: 'x',
      AGENT_BROWSER_SOCKET_DIR: '/elsewhere',
      AGENT_BROWSER_PROFILE: '/home/u/.agent-browser/profiles/google',
      AGENT_BROWSER_HEADED: '1',
      AGENT_BROWSER_ARGS: '--a=1,--b',
      AGENT_BROWSER_EXECUTABLE_PATH: '/opt/chrome',
      AGENT_BROWSER_IDLE_TIMEOUT_MS: '1800000',
      DISPLAY: ':99',
      PATH: '/usr/bin',
      AWS_SECRET_ACCESS_KEY: 'nope',
    });
    const read = procSessionLaunchEnv({ dir, procRoot });

    expect(await read('ws__g')).toEqual({
      AGENT_BROWSER_PROFILE: '/home/u/.agent-browser/profiles/google',
      AGENT_BROWSER_HEADED: '1',
      AGENT_BROWSER_ARGS: '--a=1,--b',
      AGENT_BROWSER_EXECUTABLE_PATH: '/opt/chrome',
      AGENT_BROWSER_IDLE_TIMEOUT_MS: '1800000',
      DISPLAY: ':99',
    });
  });

  it('keeps a value containing "="', async () => {
    await daemon('s', 7, {
      AGENT_BROWSER_DAEMON: '1',
      AGENT_BROWSER_SESSION: 's',
      AGENT_BROWSER_ARGS: '--x=a=b',
    });

    expect(await procSessionLaunchEnv({ dir, procRoot })('s')).toEqual({
      AGENT_BROWSER_ARGS: '--x=a=b',
    });
  });

  it('returns null when the pid belongs to something other than this session’s daemon', async () => {
    await daemon('s', 7, { AGENT_BROWSER_DAEMON: '1', AGENT_BROWSER_SESSION: 'other' });
    await daemon('t', 8, { AGENT_BROWSER_SESSION: 't', AGENT_BROWSER_HEADED: '1' });
    const read = procSessionLaunchEnv({ dir, procRoot });

    expect(await read('s')).toBeNull();
    expect(await read('t')).toBeNull();
  });

  it('returns null with no pid file, an unparsable one, or an unreadable environ', async () => {
    await writeFile(join(dir, 'bad.pid'), 'abc');
    await writeFile(join(dir, 'gone.pid'), '999');
    const read = procSessionLaunchEnv({ dir, procRoot });

    expect(await read('missing')).toBeNull();
    expect(await read('bad')).toBeNull();
    expect(await read('gone')).toBeNull();
  });

  it.each(['../x', 'a/b', '..', ''])('refuses the session name %j', async (name) => {
    expect(await procSessionLaunchEnv({ dir, procRoot })(name)).toBeNull();
  });
});
