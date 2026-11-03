import { execFile } from 'node:child_process';
import type { CodexSpawnPort } from '../ports/codex-spawn-port';
import { childEnv } from './child-env';

// Runs a script through the login shell: a service's PATH lacks the user's codex shim.
export function loginShell(shell = process.env.SHELL || '/bin/sh'): (script: string) => Promise<string> {
  return (script) =>
    new Promise((resolve, reject) => {
      execFile(shell, ['-lc', script], { env: childEnv(), timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
}

export function codexVersions(run: (script: string) => Promise<string> = loginShell()): CodexSpawnPort['versions'] {
  return async () => {
    const [cliOut, daemonOut] = await Promise.all([
      run('codex --version').catch((err: Error) => {
        throw new Error(`cannot run codex --version: ${err.message}`);
      }),
      run('codex app-server daemon version').catch((err: Error) => {
        throw new Error(`cannot read the Codex app server's version: ${err.message}`);
      }),
    ]);
    const cli = cliOut.trim().split(/\s+/).pop() ?? '';
    let appServer: unknown;
    try {
      appServer = (JSON.parse(daemonOut) as { appServerVersion?: unknown }).appServerVersion;
    } catch {
      appServer = undefined;
    }
    if (typeof appServer !== 'string' || appServer === '') throw new Error('the Codex app server is not running');
    return { cli, appServer };
  };
}
