import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { childEnv } from './infrastructure/child-env';

const exec = promisify(execFile);

// Vitest global setup. The suite drives real tmux with bare `tmux` calls and the agent's default
// paths hang off the home directory, so it must not depend on how it was started: from a Tarfa
// pane or a git hook, $TMUX names the machine's real server, whose running agent lists the test
// sessions and logs each one as closed. Workers inherit this environment.
// tmpdir(), not the repo's .tmp: a socket path has to fit about 100 bytes. A TMUX_TMPDIR the
// caller set is replaced too: it may be where the machine's real server lives.
export default async function setup(): Promise<() => Promise<void>> {
  const sandbox = await mkdtemp(join(tmpdir(), 'tarfa-test-'));
  process.env.HOME = join(sandbox, 'home');
  await mkdir(process.env.HOME);
  process.env.TMUX_TMPDIR = sandbox;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  // tmux exits once its last session is gone, so every test that killed its sessions left the
  // server exiting, and the next test's first tmux call reached it mid-exit: "server exited
  // unexpectedly". One session held for the whole run keeps that server up. Its name lacks the
  // `perch-` prefix, so no listing sees it, and it ends with this process even if teardown never
  // runs. The server it starts loads no config (`-f /dev/null`), so no tmux plugin acts on the
  // tests' sessions.
  const anchor = `tsb-anchor-${process.pid}`;
  const watch = `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done`;
  const env = childEnv();
  await exec('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', anchor, 'sh', '-c', watch], { env });

  const { stdout } = await exec('tmux', ['display-message', '-p', '#{socket_path}'], { env });
  const socket = stdout.trim();
  if (!socket.startsWith(join(await realpath(sandbox), 'tmux-'))) {
    throw new Error(`refusing to run the agent tests: tmux resolves to ${socket}, outside the sandbox`);
  }

  return async () => {
    await exec('tmux', ['-S', socket, 'kill-server'], { env }).catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  };
}
