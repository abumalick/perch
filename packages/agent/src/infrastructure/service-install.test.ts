import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serviceInstall } from './service-install';

async function dirs() {
  const repo = await mkdtemp(join(tmpdir(), 'perch-svc-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'perch-svc-home-'));
  await mkdir(join(repo, 'deploy'));
  await writeFile(join(repo, 'deploy', 'perch-agent.service'), 'unit REPO_PATH\n');
  await writeFile(join(repo, 'deploy', 'com.perch.agent.plist'), 'plist REPO_PATH\n');
  return { repo, home };
}

describe('serviceInstall', () => {
  it('installs a systemd user unit, enables it and turns linger on', async () => {
    const { repo, home } = await dirs();
    const ran: string[] = [];
    const service = serviceInstall({ repo, home, user: 'u', uid: 1000, platform: 'linux', run: async (c, a) => (ran.push([c, ...a].join(' ')), a.includes('Linger') ? 'yes\n' : '') });
    expect(service.kind).toBe('systemd');
    expect(await service.template()).toBe('unit REPO_PATH\n');
    expect(await service.installed()).toBeNull();
    await service.install('unit /r\n');
    expect(await readFile(join(home, '.config', 'systemd', 'user', 'perch-agent.service'), 'utf8')).toBe('unit /r\n');
    expect(await service.installed()).toBe('unit /r\n');
    expect(ran).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable perch-agent', 'loginctl enable-linger u']);
    expect(await service.enabled()).toBe(true);
  });

  it('is not enabled without linger, or when systemctl says it is not enabled', async () => {
    const { repo, home } = await dirs();
    const noLinger = serviceInstall({ repo, home, user: 'u', uid: 1000, platform: 'linux', run: async (_c, a) => (a.includes('Linger') ? 'no\n' : '') });
    expect(await noLinger.enabled()).toBe(false);
    const disabled = serviceInstall({
      repo,
      home,
      user: 'u',
      uid: 1000,
      platform: 'linux',
      run: async (_c, a) => {
        if (a.includes('is-enabled')) throw new Error('disabled');
        return 'yes\n';
      },
    });
    expect(await disabled.enabled()).toBe(false);
  });

  it('stops when systemctl --user cannot reach the user manager, instead of reading it as not enabled', async () => {
    const { repo, home } = await dirs();
    const run = (stderr: string) => async (_c: string, a: string[]) => {
      if (a.includes('is-enabled')) throw new Error(`systemctl --user is-enabled perch-agent failed: ${stderr}`);
      return 'yes\n';
    };
    const unreachable = serviceInstall({ repo, home, user: 'u', uid: 1000, platform: 'linux', run: run('Failed to connect to bus: No medium found') });
    await expect(unreachable.enabled()).rejects.toThrow(/XDG_RUNTIME_DIR=\/run\/user\/\$\(id -u\)/);
    const notFound = serviceInstall({ repo, home, user: 'u', uid: 1000, platform: 'linux', run: run('not-found') });
    expect(await notFound.enabled()).toBe(false);
  });

  it('installs a launchd agent, replacing a loaded one', async () => {
    const { repo, home } = await dirs();
    const ran: string[] = [];
    const service = serviceInstall({
      repo,
      home,
      user: 'u',
      uid: 501,
      platform: 'darwin',
      run: async (c, a) => {
        ran.push([c, ...a].join(' '));
        if (a[0] === 'bootout') throw new Error('not loaded');
        return '';
      },
    });
    expect(service.kind).toBe('launchd');
    await service.install('plist /r\n');
    const plist = join(home, 'Library', 'LaunchAgents', 'com.perch.agent.plist');
    expect(await readFile(plist, 'utf8')).toBe('plist /r\n');
    expect(ran).toEqual(['launchctl bootout gui/501/com.perch.agent', `launchctl bootstrap gui/501 ${plist}`]);
  });
});
