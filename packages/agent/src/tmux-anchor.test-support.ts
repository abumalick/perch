import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { childEnv } from './infrastructure/child-env';

const exec = promisify(execFile);

// Vitest global setup. tmux exits once its last session is gone, so in a sandbox (no other
// sessions) every test that killed its sessions left the server exiting, and the next test's
// first tmux call reached it mid-exit: "server exited unexpectedly". One session held for the
// whole run keeps that server up. Its name lacks the `perch-` prefix, so no listing sees it,
// and it ends with this process even if teardown never runs. The server it starts loads no
// config (`-f /dev/null`), so the user's tmux plugins never act on the tests' sessions.
// Only in a sandbox (`TMUX_TMPDIR` set, no `$TMUX`, which would win over it): anywhere else the
// default socket may be the user's own server, which must neither gain a session continuum
// would save nor be started without their config.
export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.TMUX || !process.env.TMUX_TMPDIR) return undefined;
  const name = `tsb-anchor-${process.pid}`;
  const watch = `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done`;
  const env = childEnv();
  await exec('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', name, 'sh', '-c', watch], { env });
  return async () => {
    await exec('tmux', ['kill-session', '-t', `=${name}`], { env }).catch(() => undefined);
  };
}
