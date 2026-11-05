import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ServiceInstallPort } from '../ports/service-install-port';
import { childEnv } from './child-env';

export type Run = (command: string, args: string[]) => Promise<string>;

const exec = promisify(execFile);
const systemRun: Run = async (command, args) => {
  try {
    return (await exec(command, args, { env: childEnv(), timeout: 30_000 })).stdout;
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
};

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// The agent's service as docs/DEPLOY.md installs it, from the checkout's deploy/ templates: a
// systemd user unit kept running without a login session by linger, or a launchd agent.
export function serviceInstall(options: {
  repo: string;
  home: string;
  user: string;
  uid: number;
  platform?: NodeJS.Platform;
  run?: Run;
}): ServiceInstallPort {
  const run = options.run ?? systemRun;
  if ((options.platform ?? process.platform) === 'darwin') {
    const plist = join(options.home, 'Library', 'LaunchAgents', 'com.perch.agent.plist');
    const domain = `gui/${options.uid}`;
    return {
      kind: 'launchd',
      template: () => readFile(join(options.repo, 'deploy', 'com.perch.agent.plist'), 'utf8'),
      installed: () => readOrNull(plist),
      enabled: () => run('launchctl', ['print', `${domain}/com.perch.agent`]).then(() => true, () => false),
      async install(text) {
        await mkdir(dirname(plist), { recursive: true });
        await writeFile(plist, text, 'utf8');
        // Not loaded yet is the usual case on a fresh machine.
        await run('launchctl', ['bootout', `${domain}/com.perch.agent`]).catch(() => undefined);
        await run('launchctl', ['bootstrap', domain, plist]);
        return [`wrote ${plist}`, `launchctl bootstrap ${domain}`];
      },
    };
  }
  const unit = join(options.home, '.config', 'systemd', 'user', 'perch-agent.service');
  return {
    kind: 'systemd',
    template: () => readFile(join(options.repo, 'deploy', 'perch-agent.service'), 'utf8'),
    installed: () => readOrNull(unit),
    async enabled() {
      const enabled = await run('systemctl', ['--user', 'is-enabled', 'perch-agent']).then(() => true, () => false);
      const linger = await run('loginctl', ['show-user', options.user, '-p', 'Linger', '--value']).then((out) => out.trim() === 'yes', () => false);
      return enabled && linger;
    },
    async install(text) {
      await mkdir(dirname(unit), { recursive: true });
      await writeFile(unit, text, 'utf8');
      const ran: Array<[string, string[]]> = [
        ['systemctl', ['--user', 'daemon-reload']],
        ['systemctl', ['--user', 'enable', 'perch-agent']],
        // Without linger the user's units stop at logout and do not start at boot.
        ['loginctl', ['enable-linger', options.user]],
      ];
      for (const [command, args] of ran) await run(command, args);
      return [`wrote ${unit}`, ...ran.map(([command, args]) => `${command} ${args.join(' ')}`)];
    },
  };
}
