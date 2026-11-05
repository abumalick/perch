import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

// The service's names before the rename, which setup replaces.
const LEGACY_UNIT = 'perch-agent';
const LEGACY_LABEL = 'com.perch.agent';

const NO_USER_MANAGER = /Failed to connect to (the )?(user scope )?bus/i;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

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
    const plist = join(options.home, 'Library', 'LaunchAgents', 'app.tarfa.agent.plist');
    const domain = `gui/${options.uid}`;
    const legacyPlist = join(options.home, 'Library', 'LaunchAgents', `${LEGACY_LABEL}.plist`);
    return {
      kind: 'launchd',
      template: () => readFile(join(options.repo, 'deploy', 'app.tarfa.agent.plist'), 'utf8'),
      installed: () => readOrNull(plist),
      enabled: () => run('launchctl', ['print', `${domain}/app.tarfa.agent`]).then(() => true, () => false),
      async install(text) {
        await mkdir(dirname(plist), { recursive: true });
        await writeFile(plist, text, 'utf8');
        // Not loaded yet is the usual case on a fresh machine.
        await run('launchctl', ['bootout', `${domain}/app.tarfa.agent`]).catch(() => undefined);
        await run('launchctl', ['bootstrap', domain, plist]);
        return [`wrote ${plist}`, `launchctl bootstrap ${domain}`];
      },
      legacyInstalled: async () => (await readOrNull(legacyPlist)) !== null,
      async stopLegacy() {
        await run('launchctl', ['bootout', `${domain}/${LEGACY_LABEL}`]).catch(() => undefined);
        return [`launchctl bootout ${domain}/${LEGACY_LABEL}`];
      },
      async removeLegacy() {
        await rm(legacyPlist, { force: true });
        return [`removed ${legacyPlist}`];
      },
    };
  }
  const unit = join(options.home, '.config', 'systemd', 'user', 'tarfa-agent.service');
  const legacyUnit = join(options.home, '.config', 'systemd', 'user', `${LEGACY_UNIT}.service`);
  // The old unit's drop-ins (an OOM shield, an After=tmux-server, …) name no unit, so they apply
  // to the new one as they are.
  const dropIns = `${unit}.d`;
  const legacyDropIns = `${legacyUnit}.d`;
  return {
    kind: 'systemd',
    template: () => readFile(join(options.repo, 'deploy', 'tarfa-agent.service'), 'utf8'),
    installed: () => readOrNull(unit),
    async enabled() {
      const enabled = await run('systemctl', ['--user', 'is-enabled', 'tarfa-agent']).then(
        () => true,
        (err: unknown) => {
          // Without a reachable manager every answer would read as "not enabled", and setup would
          // reinstall a working unit; a disabled or missing unit fails with other words.
          if (NO_USER_MANAGER.test(String(err instanceof Error ? err.message : err))) {
            throw new Error('systemctl --user cannot reach your user manager (no session bus): set XDG_RUNTIME_DIR=/run/user/$(id -u) (or log in as this user), then run tarfa setup again');
          }
          return false;
        },
      );
      const linger = await run('loginctl', ['show-user', options.user, '-p', 'Linger', '--value']).then((out) => out.trim() === 'yes', () => false);
      return enabled && linger;
    },
    async install(text) {
      await mkdir(dirname(unit), { recursive: true });
      await writeFile(unit, text, 'utf8');
      const copied = (await exists(legacyDropIns)) && !(await exists(dropIns));
      if (copied) await cp(legacyDropIns, dropIns, { recursive: true });
      const ran: Array<[string, string[]]> = [
        ['systemctl', ['--user', 'daemon-reload']],
        ['systemctl', ['--user', 'enable', 'tarfa-agent']],
        // Without linger the user's units stop at logout and do not start at boot.
        ['loginctl', ['enable-linger', options.user]],
      ];
      for (const [command, args] of ran) await run(command, args);
      return [`wrote ${unit}`, ...(copied ? [`copied ${legacyDropIns} to ${dropIns}`] : []), ...ran.map(([command, args]) => `${command} ${args.join(' ')}`)];
    },
    legacyInstalled: async () => (await readOrNull(legacyUnit)) !== null,
    // KillMode=process: stopping it stops the agent alone, never tmux.
    async stopLegacy() {
      const ran: Array<[string, string[]]> = [
        ['systemctl', ['--user', 'stop', LEGACY_UNIT]],
        ['systemctl', ['--user', 'disable', LEGACY_UNIT]],
      ];
      for (const [command, args] of ran) await run(command, args);
      return ran.map(([command, args]) => `${command} ${args.join(' ')}`);
    },
    async removeLegacy() {
      await rm(legacyUnit, { force: true });
      // An already current new unit skipped install(), which copies them.
      if ((await exists(legacyDropIns)) && !(await exists(dropIns))) await cp(legacyDropIns, dropIns, { recursive: true });
      await rm(legacyDropIns, { recursive: true, force: true });
      await run('systemctl', ['--user', 'daemon-reload']);
      return [`removed ${legacyUnit} and its drop-ins`, 'systemctl --user daemon-reload'];
    },
  };
}
