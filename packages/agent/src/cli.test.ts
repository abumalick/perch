import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceFingerprint, generateDeviceKeys, parsePairingLink } from '@perch/secure-channel';
import { FileDeviceStore } from './infrastructure/file-device-store';
import { parseEnvFile } from './application/agent-env';
import { enrolDevice, enrolmentMode } from './application/device-roster';
import type { Workspace } from '@perch/contracts';
import type { TmuxPort, TmuxSessionInfo } from './ports/tmux-port';
import { run, UsageError, type CliIo } from './cli';

const exec = promisify(execFile);
const sessions: string[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const name of sessions.splice(0)) {
    await exec('tmux', ['kill-session', '-t', name]).catch(() => undefined);
  }
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('perch CLI (real tmux)', () => {
  it('creates, lists, and closes a workspace end to end', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-cli-home-'));
    const project = await mkdtemp(join(tmpdir(), 'perch-cli-proj-'));
    tmpDirs.push(home, project);
    const env = { PERCH_MACHINE_ID: 'test', PERCH_TOKEN: 'test-token', PERCH_PROJECT_ROOTS: tmpdir(), PERCH_AGENT_ENV: join(home, 'agent.env') };

    const createdJson = await run(['create', project, 'sleep 30'], env, home);
    const ws = JSON.parse(createdJson) as { id: string; projectPath: string; status: string };
    sessions.push(ws.id);
    expect(ws.id.startsWith('perch-')).toBe(true);
    expect(ws.projectPath).toBe(project);
    expect(ws.status).toBe('idle');

    const listJson = await run(['list'], env, home);
    const list = JSON.parse(listJson) as Array<{ id: string }>;
    expect(list.some((w) => w.id === ws.id)).toBe(true);

    const recentJson = await run(['recent'], env, home);
    expect(JSON.parse(recentJson)).toContain(project);

    await run(['close', ws.id], env, home);
    const afterJson = await run(['list'], env, home);
    const after = JSON.parse(afterJson) as Array<{ id: string }>;
    expect(after.some((w) => w.id === ws.id)).toBe(false);
  });

  // `perch list` is the same question the PWA asks, so it must not answer it differently.
  it('stamps the agent address of the Claude session running in a workspace', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-cli-home-'));
    const project = await mkdtemp(join(tmpdir(), 'perch-cli-proj-'));
    tmpDirs.push(home, project);
    const env = { PERCH_MACHINE_ID: 'test', PERCH_TOKEN: 'test-token', PERCH_PROJECT_ROOTS: tmpdir(), PERCH_AGENT_ENV: join(home, 'agent.env') };

    const ws = JSON.parse(await run(['create', project, 'sleep 30'], env, home)) as { id: string };
    sessions.push(ws.id);

    await mkdir(join(home, '.claude', 'sessions'), { recursive: true });
    await writeFile(
      join(home, '.claude', 'sessions', '4242.json'),
      JSON.stringify({ name: 'project-ab', tmux: `${ws.id}:@1.%1` }),
      'utf8',
    );

    const list = JSON.parse(await run(['list'], env, home)) as Array<{ id: string; agentAddress?: string }>;
    expect(list.find((w) => w.id === ws.id)?.agentAddress).toBe('project-ab');
  });
});

describe('removed relay commands', () => {
  it('refuses connect, relay-key and pair --relay with one line naming what replaces them, exit 2', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-cli-home-'));
    tmpDirs.push(home);
    // No agent.env at all: the refusal needs nothing from the machine.
    const env = { PERCH_AGENT_ENV: join(home, 'agent.env') };
    for (const argv of [['connect', 'wss://relay.example', '--key', 'k'], ['relay-key'], ['pair', '--relay', 'wss://relay.example']]) {
      const refused = run(argv, env, home);
      await expect(refused).rejects.toBeInstanceOf(UsageError);
      await expect(refused).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(/^[^\n]*relays are gone[^\n]*perch setup[^\n]*perch pair[^\n]*$/) });
    }
  });
});

describe('perch install-hooks', () => {
  it('bakes in the port from the agent.env the service reads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-cli-home-'));
    tmpDirs.push(home);
    const envPath = join(home, 'agent.env');
    await writeFile(envPath, 'PERCH_MACHINE_ID=box\nPERCH_PORT=9911\n');
    await run(['install-hooks'], { PERCH_AGENT_ENV: envPath }, home);
    const settings = await readFile(join(home, '.claude', 'settings.json'), 'utf8');
    expect(settings).toContain('perch-hook.sh Stop 9911');
  });

  it('copies the kill guard beside the status hook and registers it on Bash', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-cli-home-'));
    tmpDirs.push(home);
    const envPath = join(home, 'agent.env');
    await writeFile(envPath, 'PERCH_MACHINE_ID=box\nPERCH_PORT=9911\n');
    await mkdir(join(home, '.codex'));
    await run(['install-hooks'], { PERCH_AGENT_ENV: envPath }, home);
    expect(await readFile(join(home, '.perch', 'perch-guard.sh'), 'utf8')).toContain('pkill');
    for (const file of [join(home, '.claude', 'settings.json'), join(home, '.codex', 'hooks.json')]) {
      const { hooks } = JSON.parse(await readFile(file, 'utf8')) as {
        hooks: { PreToolUse: Array<{ matcher?: string; hooks: Array<{ command: string }> }> };
      };
      expect(hooks.PreToolUse).toContainEqual({
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'bash ~/.perch/perch-guard.sh' }],
      });
    }
  });

  it('registers Codex hooks only where Codex is installed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-cli-home-'));
    tmpDirs.push(home);
    const envPath = join(home, 'agent.env');
    await writeFile(envPath, 'PERCH_MACHINE_ID=box\nPERCH_PORT=9911\n');
    await run(['install-hooks'], { PERCH_AGENT_ENV: envPath }, home);
    await expect(readFile(join(home, '.codex', 'hooks.json'), 'utf8')).rejects.toThrow();

    await mkdir(join(home, '.codex'));
    const out = await run(['install-hooks'], { PERCH_AGENT_ENV: envPath }, home);
    expect(await readFile(join(home, '.codex', 'hooks.json'), 'utf8')).toContain('perch-hook.sh Stop 9911 codex');
    expect(out).toContain('/hooks');
  });
});

describe('perch devices', () => {
  async function withPhones() {
    const home = await mkdtemp(join(tmpdir(), 'perch-cli-home-'));
    tmpDirs.push(home);
    const env = { PERCH_MACHINE_ID: 'test', PERCH_AGENT_ENV: join(home, 'agent.env') };
    const store = new FileDeviceStore(join(home, '.perch', 'devices.json'));
    const at = new Date('2026-09-24T10:00:00Z');
    const phones = [generateDeviceKeys(), generateDeviceKeys()];
    await store.update((r) =>
      phones.reduce(
        (roster, k, i) => enrolDevice(roster, { x25519: k.x25519.publicKey, ed25519: k.ed25519.publicKey, name: `phone ${i}` }, at),
        r,
      ),
    );
    const ids = phones.map((k) => deviceFingerprint(k.x25519.publicKey));
    return { home, env, store, ids };
  }

  // A roster written before names were sanitised at the handshake may still hold a hostile one.
  it('prints a device name with its control characters replaced', async () => {
    const { home, env, store, ids } = await withPhones();
    await store.update((r) => ({ ...r, devices: r.devices.map((d, i) => (i === 0 ? { ...d, name: 'evil\u001b[2J\nname' } : d)) }));
    expect(await run(['devices'], env, home)).toContain(`${ids[0]}  evil?[2J?name  enrolled`);
  });

  it('lists enrolled devices with their fingerprint, name and date, and the enrolment setting', async () => {
    const { home, env, ids } = await withPhones();
    const out = await run(['devices'], env, home);
    expect(out).toContain('enrolment: on');
    expect(out).toContain(`${ids[0]}  phone 0  enrolled 2026-09-24`);
    expect(out).toContain(`${ids[1]}  phone 1  enrolled 2026-09-24`);
    // The full key names a device when two share an id.
    const roster = JSON.parse(await readFile(join(home, '.perch', 'devices.json'), 'utf8')) as { devices: Array<{ x25519: string }> };
    expect(out).toContain(`enrolled 2026-09-24  key ${roster.devices[0]!.x25519}`);
    expect(await run(['devices', 'list'], env, home)).toBe(out);
  });

  it('revokes a device by a prefix of its fingerprint, and forgets it', async () => {
    const { home, env, store, ids } = await withPhones();
    const revoked = await run(['devices', 'revoke', ids[0]!.slice(0, 4)], env, home);
    expect(revoked).toContain(`revoked ${ids[0]} (phone 0)`);
    expect(revoked).toContain('whoever holds the token can still enrol a new key');
    const roster = await store.read();
    expect(roster.devices.map((d) => d.id)).toEqual([ids[1]]);
    expect(roster.revoked.map((d) => d.id)).toEqual([ids[0]]);
    expect(await run(['devices'], env, home)).toContain(`${ids[0]}  phone 0  revoked`);
    expect(await run(['devices', 'forget', ids[0]!], env, home)).toContain(`forgot ${ids[0]}`);
    expect((await store.read()).revoked).toEqual([]);
  });

  it('refuses an unknown or ambiguous device id', async () => {
    const { home, env } = await withPhones();
    await expect(run(['devices', 'revoke', 'ffff-ffff-ffff'], env, home)).rejects.toThrow(/no single device/);
    await expect(run(['devices', 'revoke'], env, home)).rejects.toThrow(/usage/);
  });

  it('sets enrolment on, off (pairing codes only) or closed, and lists it', async () => {
    const { home, env, store } = await withPhones();
    expect(await run(['devices', 'enrolment', 'off'], env, home)).toContain('enrolment: off');
    expect(enrolmentMode(await store.read())).toBe('off');
    expect(await run(['devices'], env, home)).toContain('enrolment: off (only a pairing code from `perch pair` enrols a phone)');
    await run(['devices', 'enrolment', 'closed'], env, home);
    expect(enrolmentMode(await store.read())).toBe('closed');
    expect(await run(['devices'], env, home)).toContain('enrolment: closed (no new phone can enrol)');
    await run(['devices', 'enrolment', 'on'], env, home);
    expect(enrolmentMode(await store.read())).toBe('on');
    await expect(run(['devices', 'enrolment', 'maybe'], env, home)).rejects.toThrow(/usage/);
    await expect(run(['devices', 'enrolment'], env, home)).rejects.toThrow(/usage/);
  });

  it('warns after a revoke only while the token can still enrol a new key', async () => {
    const { home, env, ids } = await withPhones();
    await run(['devices', 'enrolment', 'off'], env, home);
    expect(await run(['devices', 'revoke', ids[0]!], env, home)).not.toContain('token');
  });
});

describe('perch pair (arguments and agent.env)', () => {
  async function machine(envText: string) {
    const home = await mkdtemp(join(tmpdir(), 'perch-pair-home-'));
    tmpDirs.push(home);
    const envPath = join(home, 'agent.env');
    await writeFile(envPath, envText);
    return { home, env: { PERCH_AGENT_ENV: envPath } };
  }
  const base = 'PERCH_MACHINE_ID=box\nPERCH_TOKEN=t\nPERCH_PHONE_ADDRESSES=wss://box.example.ts.net\n';

  it('mints a pairing link for the phone address, reading the agent.env the service reads', async () => {
    const { home, env } = await machine(`${base}PERCH_PWA_ORIGIN=https://pwa.example:8443\n`);
    const out = await run(['pair'], { ...env, PERCH_PHONE_ADDRESSES: 'wss://stale.example.ts.net' }, home);
    const link = out.split('\n').find((line) => line.startsWith('https://'))!;
    const pairing = parsePairingLink(link)!;
    expect(pairing.urls).toEqual(['wss://box.example.ts.net']);
    expect(pairing.name).toBe('box');
    const stored = JSON.parse(await readFile(join(home, '.perch', 'pairing.json'), 'utf8')) as Array<{ secret: string }>;
    expect(stored.map((p) => p.secret)).toEqual([pairing.secret]);
    expect(out).toContain('10 minutes');
    // The phone shows the same fingerprint before it pairs, to compare by eye.
    expect(out).toContain(`machine key ${deviceFingerprint(pairing.agentKey)};`);
  });

  it('hands the phone the PERCH_DEFAULT_PATH agent.env sets', async () => {
    const { home, env } = await machine(`${base}PERCH_PWA_ORIGIN=https://pwa.example:8443\nPERCH_DEFAULT_PATH=/home/u/workspace\n`);
    const out = await run(['pair'], env, home);
    expect(parsePairingLink(out.split('\n').find((line) => line.startsWith('https://'))!)!.defaultPath).toBe('/home/u/workspace');
  });

  it('names the pairing after the host when the machine id is the generic "local"', async () => {
    const { home, env } = await machine('PERCH_MACHINE_ID=local\nPERCH_TOKEN=t\nPERCH_PHONE_ADDRESSES=wss://box.example.ts.net\nPERCH_PWA_ORIGIN=https://pwa.example:8443\n');
    const out = await run(['pair'], env, home);
    const pairing = parsePairingLink(out.split('\n').find((line) => line.startsWith('https://'))!)!;
    expect(pairing.name).toBe(hostname().split('.')[0]);
  });

  it('takes --pwa over PERCH_PWA_ORIGIN, and the tarfa.app default without either', async () => {
    const { home, env } = await machine(base);
    expect(await run(['pair'], env, home)).toContain('https://tarfa.app/#pair?');
    const out = await run(['pair', '--pwa', 'https://pwa.example/ignored/path'], env, home);
    expect(out).toContain('https://pwa.example/#pair?');
  });

  it('refuses a machine with no PERCH_PHONE_ADDRESSES, pointing at perch setup', async () => {
    const { home, env } = await machine('PERCH_MACHINE_ID=box\nPERCH_TOKEN=t\nPERCH_RELAY_URLS=wss://relay.example\n');
    await expect(run(['pair'], env, home)).rejects.toThrow(/PERCH_PHONE_ADDRESSES.*perch setup/);
  });

  it('mints a link with every PERCH_PHONE_ADDRESSES address, in order', async () => {
    const { home, env } = await machine(
      'PERCH_MACHINE_ID=dev\nPERCH_TOKEN=t\nPERCH_DEFAULT_PATH=/home/u/workspace\n' +
        'PERCH_PHONE_ADDRESSES=wss://dev.example.ts.net:10000/abu,wss://dev.example.ts.net:8443/abu\n',
    );
    const out = await run(['pair'], env, home);
    const link = out.split('\n').find((line) => line.startsWith('https://'))!;
    const { agentKey, secret } = parsePairingLink(link)!;
    expect(link).toBe(
      `https://tarfa.app/#pair?u=wss://dev.example.ts.net:10000/abu&u=wss://dev.example.ts.net:8443/abu&k=${agentKey}&s=${secret}&n=dev&p=/home/u/workspace`,
    );
  });

  it('refuses a PERCH_PHONE_ADDRESSES address a phone would refuse', async () => {
    const { home, env } = await machine('PERCH_MACHINE_ID=box\nPERCH_TOKEN=t\nPERCH_PHONE_ADDRESSES=ws://dev.example.ts.net/abu\n');
    await expect(run(['pair'], env, home)).rejects.toThrow(/PERCH_PHONE_ADDRESSES/);
  });
});

describe('perch setup (fake service and Tailscale)', () => {
  const HOST = 'dev.example.ts.net';
  async function machine(envText: string | null = null) {
    const root = await mkdtemp(join(tmpdir(), 'perch-setup-'));
    tmpDirs.push(root);
    const repo = join(root, 'repo');
    const home = join(root, 'home');
    await mkdir(join(repo, 'deploy'), { recursive: true });
    await mkdir(home);
    await writeFile(join(repo, 'deploy', 'perch-agent.service'), '[Service]\nExecStart=/usr/bin/env bash REPO_PATH/deploy/run-agent.sh\nKillMode=process\n');
    const envPath = join(repo, 'deploy', 'agent.env');
    if (envText !== null) await writeFile(envPath, envText, { mode: 0o600 });
    const calls: string[] = [];
    let unit: string | null = null;
    let served: Record<string, unknown> = {};
    const io: CliIo = {
      setup: {
        service: {
          kind: 'systemd',
          template: () => readFile(join(repo, 'deploy', 'perch-agent.service'), 'utf8'),
          installed: async () => unit,
          enabled: async () => unit !== null,
          install: async (text) => {
            // The roster must be on disk before the service can first start.
            calls.push(`install-unit roster=${await readFile(join(home, '.perch', 'devices.json'), 'utf8').then(() => 'present', () => 'absent')}`);
            unit = text;
            return ['enabled'];
          },
        },
        tailscale: {
          status: async () => ({
            BackendState: 'Running',
            CurrentTailnet: { MagicDNSEnabled: true },
            CertDomains: [HOST],
            Self: { DNSName: `${HOST}.`, CapMap: { funnel: null, 'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': null } },
          }),
          serveStatus: async () => served,
          serve: async (entry) => {
            calls.push(`serve ${entry.port}${entry.path} ${entry.target} funnel=${entry.funnel}`);
            const hostPort = `${HOST}:${entry.port}`;
            served = { TCP: { [entry.port]: { HTTPS: true } }, Web: { [hostPort]: { Handlers: { [entry.path]: { Proxy: entry.target } } } }, AllowFunnel: { [hostPort]: entry.funnel } };
          },
        },
        portOwner: async () => 'free',
        restart: { restart: async () => (calls.push('restart'), 'restarted') },
        checkListener: async () => (calls.push('check'), true),
      },
    };
    return { repo, home, env: { PERCH_AGENT_ENV: envPath }, envPath, calls, io };
  }
  const FLAGS = ['--machine-id', 'dev', '--project-roots', '/home/u/workspace', '--tailscale', 'funnel', '--slug', 'abu'];

  it('sets a fresh machine up, then changes nothing when rerun', async () => {
    const m = await machine();
    const out = await run(['setup', ...FLAGS], m.env, m.home, m.io);
    expect(out).toContain('the phone port answers');
    expect(m.calls).toEqual(['install-unit roster=present', 'serve 10000/abu http://127.0.0.1:8797 funnel=true', 'restart', 'check']);
    const values = parseEnvFile(await readFile(m.envPath, 'utf8'));
    expect(values).toMatchObject({ PERCH_MACHINE_ID: 'dev', PERCH_PHONE_ADDRESSES: `wss://${HOST}:10000/abu`, PERCH_PWA_ORIGIN: 'https://tarfa.app' });
    expect(values.PERCH_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    // What run-agent.sh does with it: bash reads back exactly what was written.
    const sourced = await promisify(execFile)('bash', ['-c', '. "$1"; printf %s "$PERCH_PHONE_ADDRESSES|$PERCH_PROJECT_ROOTS"', '_', m.envPath], { env: {} });
    expect(sourced.stdout).toBe(`wss://${HOST}:10000/abu|/home/u/workspace`);
    expect(enrolmentMode(await new FileDeviceStore(join(m.home, '.perch', 'devices.json')).read())).toBe('off');
    expect(JSON.parse(await readFile(join(m.home, '.perch', 'relay-key.json'), 'utf8'))).toHaveProperty('x25519');
    expect(await readFile(join(m.home, '.claude', 'settings.json'), 'utf8')).toContain('perch-hook.sh');

    m.calls.length = 0;
    const env = await readFile(m.envPath, 'utf8');
    expect(await run(['setup', ...FLAGS], m.env, m.home, m.io)).toMatch(/already set up/);
    expect(m.calls).toEqual(['check']);
    expect(await readFile(m.envPath, 'utf8')).toBe(env);
  });

  it('prints a pairing link with --pair', async () => {
    const m = await machine();
    const out = await run(['setup', ...FLAGS, '--pair'], m.env, m.home, m.io);
    const link = out.split('\n').find((line) => line.startsWith('https://tarfa.app/#pair?'))!;
    expect(parsePairingLink(link)!.urls).toEqual([`wss://${HOST}:10000/abu`]);
  });

  it('changes nothing on a dry run', async () => {
    const m = await machine('PERCH_TOKEN=keep\n');
    const out = await run(['setup', ...FLAGS, '--dry-run'], m.env, m.home, m.io);
    expect(out).toContain('tailscale: Funnel allowed on port 10000');
    expect(out).toContain('tailscale funnel --bg --https=10000 --set-path=/abu http://127.0.0.1:8797');
    expect(m.calls).toEqual([]);
    expect(await readFile(m.envPath, 'utf8')).toBe('PERCH_TOKEN=keep\n');
    await expect(readFile(join(m.home, '.perch', 'devices.json'))).rejects.toThrow();
  });

  it('explains itself with --help: Funnel, slugs and the second user', async () => {
    const m = await machine();
    const help = await run(['setup', '--help'], m.env, m.home, m.io);
    expect(help).toContain('funnel');
    expect(help).toContain('--slug');
    expect(help).toContain('sudo tailscale set --operator=$USER');
  });

  it('answers an unknown flag with the usage and exit code 2', async () => {
    const m = await machine();
    await expect(run(['setup', ...FLAGS, '--bogus', 'x'], m.env, m.home, m.io)).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('usage: perch setup') });
  });
});

// `ls`, `spawn` and `peek` run against a fake tmux: these tests never reach a tmux server.
describe('perch ls / spawn / peek (fake tmux)', () => {
  const NOW = 1_800_000_000_000;
  const live: TmuxSessionInfo[] = [
    { name: 'perch-aaaaaa', startPath: '/w/foo', command: 'claude', createdAt: NOW - 3_600_000, title: '✳ Fix login' },
    { name: 'perch-bbbbbb', startPath: '/w/bar', command: 'claude', createdAt: NOW - 60_000, parent: 'perch-aaaaaa', title: '✳ Child' },
    { name: 'perch-hhhhhh', startPath: '/w/secret/x', command: 'claude', createdAt: NOW, title: '✳ Hidden' },
  ];

  function fakeTmux(pane: Record<string, string> = {}, extra: TmuxSessionInfo[] = []) {
    const created: Array<{ name: string; cwd: string; command: string; parent?: string; storedCommand?: string; codexThread?: string }> = [];
    const locked: string[] = [];
    const titles: string[] = [];
    const tmux: TmuxPort = {
      listSessions: async (prefix) => [...live, ...extra].filter((s) => s.name.startsWith(prefix)),
      createSession: async (input) => {
        created.push(input);
      },
      killSession: async () => {
        throw new Error('ls/spawn/peek must never kill');
      },
      hasSession: async (name) => live.some((s) => s.name === name) || created.some((c) => c.name === name),
      setPaneTitle: async (name, title) => {
        titles.push(`${name} ${title}`);
      },
      supportsTitleLock: async () => true,
      lockPaneTitle: async (name) => {
        locked.push(name);
      },
      capturePane: async () => 'old\n\nline 1\n   \nline 2\nline 3\n\n\n',
      sessionOfPane: async (id) => pane[id] ?? null,
    };
    return { tmux, created, locked, titles };
  }

  async function machine() {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.tmp');
    await mkdir(root, { recursive: true });
    const home = await mkdtemp(join(root, 'cli-ls-'));
    tmpDirs.push(home);
    await mkdir(join(home, '.perch'));
    await writeFile(join(home, '.perch', 'hidden-folders.json'), '["secret"]');
    // No agent.env at all: these commands must work from any repo's session.
    const env = { PERCH_AGENT_ENV: join(home, 'no-such-agent.env') };
    return { home, env };
  }

  // The brief file is named by a nonce; the launch command names it.
  const spawnedBrief = (home: string, created: Array<{ name: string; command: string }>, id: string) => {
    const path = /cat '([^']+)'/.exec(created.find((c) => c.name === id)!.command)![1]!;
    expect(path.startsWith(join(home, '.perch', 'spawn'))).toBe(true);
    return readFile(path, 'utf8');
  };

  const io = (tmux: TmuxPort, extra: Partial<CliIo> = {}): CliIo => ({ tmux, now: () => NOW, sleep: async () => {}, ...extra });

  it('lists live and parked workspaces with their stored status, without an agent.env', async () => {
    const { home, env } = await machine();
    await writeFile(join(home, '.perch', 'status.json'), JSON.stringify({ 'perch-bbbbbb': { status: 'needs-feedback', changedAt: NOW - 120_000, urgent: true } }));
    await writeFile(
      join(home, '.perch', 'parked.json'),
      JSON.stringify([{ id: 'perch-pppppp', name: 'Parked one', projectPath: '/w/foo', command: 'claude', machineId: 'm', createdAt: 1, parkedAt: NOW - 86_400_000 }]),
    );
    const out = await run(['ls'], env, home, io(fakeTmux().tmux));
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^ID +NAME +STATUS +AGE +ROLE +PARENT +TITLE +FOLDER$/);
    expect(out).toMatch(/perch-aaaaaa +- +idle +1h +orchestrator +- +Fix login +\/w\/foo/);
    expect(out).toMatch(/perch-bbbbbb +- +needs-feedback \(urgent\) +2m +child +perch-aaaaaa +Child/);
    expect(out).toMatch(/perch-pppppp +- +parked +1d +normal /);
    expect(out).not.toContain('perch-hhhhhh');
    const json = JSON.parse(await run(['ls', '--json'], env, home, io(fakeTmux().tmux))) as Workspace[];
    expect(json.map((w) => w.id)).toEqual(['perch-aaaaaa', 'perch-bbbbbb', 'perch-pppppp']);
    expect(json[0]!.machineId).toBe(hostname().split('.')[0]);
    expect(json[1]!.parentId).toBe('perch-aaaaaa');
    expect(json.map((w) => (w as Workspace & { role: string }).role)).toEqual(['orchestrator', 'child', 'normal']);
  });

  it('shows a child whose last act was SendMessage as waiting on its orchestrator', async () => {
    const { home, env } = await machine();
    await writeFile(join(home, '.perch', 'status.json'), JSON.stringify({ 'perch-bbbbbb': { status: 'working', changedAt: NOW, messagedLast: true } }));
    const json = JSON.parse(await run(['ls', '--json'], env, home, io(fakeTmux().tmux))) as Workspace[];
    expect(json.find((w) => w.id === 'perch-bbbbbb')?.waitingOn).toBe('parent');
    expect(await run(['ls'], env, home, io(fakeTmux().tmux))).toMatch(/perch-bbbbbb +- +needs-orchestrator /);
  });

  it('never writes the status file it reads', async () => {
    const { home, env } = await machine();
    const status = JSON.stringify({ 'perch-gone00': { status: 'working', changedAt: 1 } });
    await writeFile(join(home, '.perch', 'status.json'), status);
    await run(['ls'], env, home, io(fakeTmux().tmux));
    expect(await readFile(join(home, '.perch', 'status.json'), 'utf8')).toBe(status);
  });

  it('still lists when status.json or parked.json is corrupt, missing, or not a file', async () => {
    const { home, env } = await machine();
    await writeFile(join(home, '.perch', 'status.json'), '{not json');
    await writeFile(join(home, '.perch', 'parked.json'), '[{"x"');
    expect(await run(['ls'], env, home, io(fakeTmux().tmux))).toContain('perch-aaaaaa');
    await rm(join(home, '.perch', 'status.json'));
    await rm(join(home, '.perch', 'parked.json'));
    expect(await run(['ls'], env, home, io(fakeTmux().tmux))).toContain('perch-aaaaaa');
    await mkdir(join(home, '.perch', 'status.json'));
    await mkdir(join(home, '.perch', 'parked.json'));
    expect(await run(['ls'], env, home, io(fakeTmux().tmux))).toContain('perch-aaaaaa');
  });

  it('filters by role, keeping the role the whole list gives', async () => {
    const { home, env } = await machine();
    const ids = async (...argv: string[]) => (JSON.parse(await run(['ls', '--json', ...argv], env, home, io(fakeTmux().tmux))) as Workspace[]).map((w) => w.id);
    expect(await ids('--role', 'orchestrator')).toEqual(['perch-aaaaaa']);
    expect(await ids('--role', 'child')).toEqual(['perch-bbbbbb']);
    expect(await ids('--role', 'normal')).toEqual([]);
    await expect(run(['ls', '--role', 'boss'], env, home, io(fakeTmux().tmux))).rejects.toThrow(/usage: perch ls/);
  });

  it('filters by project path: the directory and everything under it, relative to the caller', async () => {
    const { home, env } = await machine();
    const ids = async (cwd: string, ...argv: string[]) =>
      (JSON.parse(await run(['ls', '--json', ...argv], env, home, io(fakeTmux().tmux, { cwd }))) as Workspace[]).map((w) => w.id);
    expect(await ids('/', '--path', '/w/foo')).toEqual(['perch-aaaaaa']);
    expect(await ids('/', '--path', '/w')).toEqual(['perch-aaaaaa', 'perch-bbbbbb']);
    expect(await ids('/w', '--path', 'bar')).toEqual(['perch-bbbbbb']);
    expect(await ids('/w/bar', '--path', '.')).toEqual(['perch-bbbbbb']);
    expect(await ids('/', '--path', '/w/fo')).toEqual([]);
    const out = await run(['ls', '--path', '/w/bar'], env, home, io(fakeTmux().tmux, { cwd: '/' }));
    expect(out).toMatch(/perch-bbbbbb .* child +perch-aaaaaa/);
  });

  it('matches --path through a symlink, since spawn stores the resolved folder', async () => {
    const { home, env } = await machine();
    const real = await realpath(await mkdtemp(join(home, 'real-')));
    await symlink(real, join(home, 'link'));
    await writeFile(
      join(home, '.perch', 'parked.json'),
      JSON.stringify([{ id: 'perch-pppppp', name: 'Parked one', projectPath: real, command: 'claude', machineId: 'm', createdAt: 1, parkedAt: NOW }]),
    );
    const out = await run(['ls', '--json', '--path', join(home, 'link')], env, home, io(fakeTmux().tmux, { cwd: '/' }));
    expect((JSON.parse(out) as Workspace[]).map((w) => w.id)).toEqual(['perch-pppppp']);
  });

  it('filters by parent, and --mine by the workspace the caller runs in', async () => {
    const { home, env } = await machine();
    const { tmux } = fakeTmux({ '%7': 'perch-aaaaaa' });
    const ids = (out: string) => (JSON.parse(out) as Workspace[]).map((w) => w.id);
    expect(ids(await run(['ls', '--json', '--parent', 'perch-aaaaaa'], env, home, io(tmux)))).toEqual(['perch-bbbbbb']);
    expect(ids(await run(['ls', '--json', '--mine'], { ...env, TMUX_PANE: '%7' }, home, io(tmux)))).toEqual(['perch-bbbbbb']);
    await expect(run(['ls', '--mine'], env, home, io(tmux))).rejects.toThrow(/TMUX_PANE/);
    await expect(run(['ls', '--mine'], { ...env, TMUX_PANE: '%8' }, home, io(tmux))).rejects.toThrow(/not inside a Perch workspace/);
    await expect(run(['ls', '--parent'], env, home, io(tmux))).rejects.toThrow(/usage: perch ls/);
  });

  it('unparks through the running agent, one line per id, failing if any did not open', async () => {
    const { home } = await machine();
    await writeFile(join(home, '.perch', 'token'), 'hook-secret');
    const env = { PERCH_AGENT_ENV: join(home, 'agent.env') };
    await writeFile(env.PERCH_AGENT_ENV, 'PERCH_PORT=9911\n');
    const calls: Array<{ url: string; auth: string; body: string }> = [];
    const results: Record<string, string> = { 'perch-aaaaaa': 'unparked', 'perch-bbbbbb': 'not-parked', 'perch-cccccc': 'missing-directory' };
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') ?? '', body });
      const { id } = JSON.parse(body) as { id: string };
      return new Response(JSON.stringify({ result: results[id] }), { status: 200 });
    };
    expect(await run(['unpark', 'perch-aaaaaa'], env, home, io(fakeTmux().tmux, { fetch }))).toBe('perch-aaaaaa: opened');
    expect(calls[0]).toEqual({ url: 'http://127.0.0.1:9911/unpark', auth: 'Bearer hook-secret', body: '{"id":"perch-aaaaaa"}' });
    // Every id is tried; the failures are reported together.
    await expect(run(['unpark', 'perch-bbbbbb', 'perch-aaaaaa', 'perch-cccccc'], env, home, io(fakeTmux().tmux, { fetch }))).rejects.toThrow(
      'perch-bbbbbb: not parked\nperch-aaaaaa: opened\nperch-cccccc: its project directory no longer exists',
    );
    await expect(run(['unpark'], env, home, io(fakeTmux().tmux, { fetch }))).rejects.toThrow(/usage: perch unpark/);
  });

  it('says the agent is not running when nothing answers', async () => {
    const { home, env } = await machine();
    await writeFile(join(home, '.perch', 'token'), 'hook-secret');
    const fetch = async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    };
    await expect(run(['unpark', 'perch-aaaaaa'], env, home, io(fakeTmux().tmux, { fetch }))).rejects.toThrow(/agent is not running/);
    await rm(join(home, '.perch', 'token'));
    await expect(run(['unpark', 'perch-aaaaaa'], env, home, io(fakeTmux().tmux, { fetch }))).rejects.toThrow(/agent is not running/);
  });

  describe('send', () => {
    async function agent(answer: (body: Record<string, unknown>) => Response = () => Response.json({ result: 'delivered' })) {
      const { home } = await machine();
      await writeFile(join(home, '.perch', 'token'), 'hook-secret');
      const env = { PERCH_AGENT_ENV: join(home, 'agent.env'), TMUX_PANE: '%3' };
      await writeFile(env.PERCH_AGENT_ENV, 'PERCH_PORT=9911\n');
      const calls: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
      const fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') ?? '', body });
        return answer(body);
      };
      return { home, env, calls, fetch };
    }

    it('send posts pane, pid, to and body to /message', async () => {
      const { home, env, calls, fetch } = await agent();
      expect(await run(['send', 'perch-orch-1', 'done: see PR'], env, home, io(fakeTmux().tmux, { fetch }))).toBe('delivered to perch-orch-1');
      expect(calls).toEqual([
        {
          url: 'http://127.0.0.1:9911/message',
          auth: 'Bearer hook-secret',
          body: { pane: '%3', pid: process.pid, to: 'perch-orch-1', body: 'done: see PR' },
        },
      ]);
    });

    it('send reads the body from stdin when no message argument', async () => {
      const { home, env, calls, fetch } = await agent();
      const stdin = async () => 'a long\nreport\n';
      expect(await run(['send', 'perch-orch-1'], env, home, io(fakeTmux().tmux, { fetch, stdin }))).toBe('delivered to perch-orch-1');
      expect(calls[0]!.body.body).toBe('a long\nreport\n');
    });

    it('send refuses --file and extra arguments with usage', async () => {
      const { home, env, calls, fetch } = await agent();
      const usage = /usage: perch send <workspace id> "<message>"/;
      for (const argv of [['send'], ['send', 'perch-orch-1', 'a', 'b'], ['send', '--file', 'x', 'perch-orch-1'], ['send', 'perch-orch-1', '-f', 'x']]) {
        await expect(run(argv, env, home, io(fakeTmux().tmux, { fetch }))).rejects.toThrow(usage);
      }
      await expect(run(['send', 'perch-orch-1', 'hi'], { ...env, TMUX_PANE: undefined }, home, io(fakeTmux().tmux, { fetch }))).rejects.toThrow(
        'not inside a Perch workspace: $TMUX_PANE is unset',
      );
      expect(calls).toEqual([]);
    });

    // Codex bound to its daemon runs tools outside the pane, with the daemon's stale TMUX_PANE or
    // none: the thread id is what names the sender there.
    it('send from Codex posts its thread id too', async () => {
      const { home, env, calls, fetch } = await agent();
      await run(['send', 'perch-orch-1', 'hi'], { ...env, CODEX_THREAD_ID: 't1' }, home, io(fakeTmux().tmux, { fetch }));
      expect(calls[0]!.body).toEqual({ pane: '%3', pid: process.pid, to: 'perch-orch-1', body: 'hi', codexThread: 't1' });
    });

    it('send from Codex does not need TMUX_PANE', async () => {
      const { home, env, calls, fetch } = await agent();
      const codexEnv = { ...env, TMUX_PANE: undefined, CODEX_THREAD_ID: 't1' };
      expect(await run(['send', 'perch-orch-1', 'hi'], codexEnv, home, io(fakeTmux().tmux, { fetch }))).toBe('delivered to perch-orch-1');
      expect(calls[0]!.body).toMatchObject({ pane: '', codexThread: 't1' });
    });

    it('a refusal throws its reason', async () => {
      const { home, env, fetch } = await agent(() => Response.json({ result: 'refused', reason: 'cannot message yourself' }));
      await expect(run(['send', 'perch-child-1', 'hi'], env, home, io(fakeTmux().tmux, { fetch }))).rejects.toThrow('cannot message yourself');
    });

    it('agent not running', async () => {
      const { home, env } = await agent();
      const fetch = async () => {
        throw new TypeError('fetch failed');
      };
      await expect(run(['send', 'perch-orch-1', 'hi'], env, home, io(fakeTmux().tmux, { fetch }))).rejects.toThrow(/agent is not running/);
    });
  });

  it('spawns from the caller cwd with the brief from stdin, and prints the id', async () => {
    const { home, env } = await machine();
    await mkdir(join(home, 'proj'));
    const { tmux, created, locked } = fakeTmux();
    const id = await run(['spawn', '--title', 'T', 'proj'], env, home, io(tmux, { cwd: home, stdin: async () => 'Do it.\n' }));
    expect(id).toBe('proj-1');
    expect(created[0]!.cwd).toBe(await realpath(join(home, 'proj')));
    expect(created[0]!.storedCommand).toBe(`claude --model 'opus[1m]' --name ${id}`);
    // The title is held by tmux's lock, not by the env switch that also silences OSC 7501.
    expect(locked).toEqual([id]);
    expect(created[0]!.command).not.toContain('CLAUDE_CODE_DISABLE_TERMINAL_TITLE');
    expect(await spawnedBrief(home, created, id)).toBe('Do it.\n');
  });

  it('spawns a child of the caller, telling it to ask the parent with perch send', async () => {
    const { home, env } = await machine();
    const { tmux, created } = fakeTmux({ '%7': 'perch-aaaaaa' });
    const id = await run(['spawn', '--child', '--model', 'sonnet[1m]', home], { ...env, TMUX_PANE: '%7' }, home, io(tmux, { stdin: async () => 'b' }));
    expect(created[0]!.parent).toBe('perch-aaaaaa');
    expect(created[0]!.storedCommand).toContain("--model 'sonnet[1m]'");
    const brief = await spawnedBrief(home, created, id);
    expect(brief).toContain('perch send perch-aaaaaa "');
  });

  it('spawns a codex child on a thread the app server creates', async () => {
    const { home, env } = await machine();
    const { tmux, created } = fakeTmux({ '%7': 'perch-aaaaaa' });
    const threads: unknown[] = [];
    const codex = {
      versions: async () => ({ cli: '0.166.0', appServer: '0.166.0' }),
      createThread: async (input: unknown) => {
        threads.push(input);
        return 'th-9';
      },
    };
    await run(['spawn', '--child', '--cli', 'codex', home], { ...env, TMUX_PANE: '%7' }, home, io(tmux, { stdin: async () => 'b', codex }));
    expect(threads).toMatchObject([{ firstMessage: 'b' }]);
    expect(created[0]).toMatchObject({ command: 'codex resume th-9', parent: 'perch-aaaaaa', codexThread: 'th-9' });
  });

  // Codex under its daemon runs tools outside the pane, with the TMUX_PANE of whichever pane
  // started the daemon: the thread names the caller.
  const codexCaller = { name: 'perch-cccccc', startPath: '/w/foo', command: 'codex resume th-1', codexThread: 'th-1', createdAt: NOW, title: '' };

  it('names a Codex caller by its thread, not by a stale TMUX_PANE', async () => {
    const { home, env } = await machine();
    const { tmux, created } = fakeTmux({ '%7': 'perch-aaaaaa' }, [codexCaller]);
    const codexEnv = { ...env, TMUX_PANE: '%7', CODEX_THREAD_ID: 'th-1' };
    await run(['spawn', '--child', home], codexEnv, home, io(tmux, { stdin: async () => 'b' }));
    expect(created[0]!.parent).toBe('perch-cccccc');
    const mine = JSON.parse(await run(['ls', '--json', '--mine'], codexEnv, home, io(tmux))) as Workspace[];
    expect(mine).toEqual([]);
  });

  it('refuses a Codex caller whose thread no workspace records', async () => {
    const { home, env } = await machine();
    const { tmux, created } = fakeTmux({ '%7': 'perch-aaaaaa' }, [codexCaller]);
    const codexEnv = { ...env, TMUX_PANE: '%7', CODEX_THREAD_ID: 'zz' };
    const refusal = 'not inside a Perch workspace: no workspace records Codex thread zz';
    await expect(run(['spawn', '--child', home], codexEnv, home, io(tmux, { stdin: async () => 'b' }))).rejects.toThrow(refusal);
    await expect(run(['rename', 'x'], codexEnv, home, io(tmux))).rejects.toThrow(refusal);
    await expect(run(['ls', '--mine'], codexEnv, home, io(tmux))).rejects.toThrow(refusal);
    expect(created).toEqual([]);
  });

  it('spawns pi through pi-reviewed', async () => {
    const { home, env } = await machine();
    const { tmux, created } = fakeTmux();
    const asked: string[] = [];
    const resolveCommand = async (name: string) => (asked.push(name), true);
    await run(['spawn', '--cli', 'pi', home], env, home, io(tmux, { stdin: async () => 'b', resolveCommand }));
    expect(created[0]!.storedCommand).toBe('pi-reviewed');
    expect(asked).toEqual(['pi-reviewed']);
  });

  it('refuses a pi spawn when pi-reviewed is not on the login PATH', async () => {
    const { home, env } = await machine();
    const { tmux, created } = fakeTmux();
    const resolveCommand = async () => false;
    await expect(run(['spawn', '--cli', 'pi', home], env, home, io(tmux, { stdin: async () => 'b', resolveCommand }))).rejects.toThrow(
      'perch spawn --cli pi needs pi-reviewed on PATH',
    );
    expect(created).toEqual([]);
  });

  it('rejects --cli bash', async () => {
    const { home, env } = await machine();
    const { tmux, created } = fakeTmux();
    await expect(run(['spawn', '--cli', 'bash', home], env, home, io(tmux, { stdin: async () => 'b' }))).rejects.toThrow(
      'usage: perch spawn [--title <title>] [--child] [--model <model>] [--cli claude|codex|pi] <projectPath>',
    );
    expect(created).toEqual([]);
  });

  it('gives a spawn the smallest free id for its folder', async () => {
    const { home, env } = await machine();
    const project = join(home, 'My.App');
    await mkdir(project);
    const { tmux } = fakeTmux();
    const first = await run(['spawn', project], env, home, io(tmux, { stdin: async () => 'b' }));
    const second = await run(['spawn', project], env, home, io(tmux, { stdin: async () => 'b' }));
    expect([first, second]).toEqual(['my-app-1', 'my-app-2']);
  });

  it('renames the caller, or the workspace a first word names, under a locked title', async () => {
    const { home, env } = await machine();
    const { tmux, locked, titles } = fakeTmux({ '%7': 'perch-aaaaaa' });
    const pane = { ...env, TMUX_PANE: '%7' };
    expect(await run(['rename', 'Invoice', 'PDF', 'fix'], pane, home, io(tmux))).toBe('perch-aaaaaa: renamed to "Invoice PDF fix"');
    expect(await run(['rename', 'perch-bbbbbb', 'Child', 'two'], pane, home, io(tmux))).toBe('perch-bbbbbb: renamed to "Child two"');
    // One word is always a title, even one that looks like an id.
    expect(await run(['rename', 'perch-bbbbbb'], pane, home, io(tmux))).toBe('perch-aaaaaa: renamed to "perch-bbbbbb"');
    expect(locked).toEqual(['perch-aaaaaa', 'perch-bbbbbb', 'perch-aaaaaa']);
    expect(titles).toEqual(['perch-aaaaaa ✳ Invoice PDF fix', 'perch-bbbbbb ✳ Child two', 'perch-aaaaaa ✳ perch-bbbbbb']);
    await expect(run(['rename', 'perch-9', 'x'], pane, home, io(tmux))).rejects.toThrow(/no workspace perch-9/);
    await expect(run(['rename'], pane, home, io(tmux))).rejects.toThrow(/usage: perch rename/);
    await expect(run(['rename', 'x'], env, home, io(tmux))).rejects.toThrow(/TMUX_PANE/);
  });

  it('refuses a child outside a Perch pane, and a spawn without a path', async () => {
    const { home, env } = await machine();
    const { tmux, created } = fakeTmux({ '%9': 'main' });
    const stdin = async () => 'b';
    await expect(run(['spawn', '--child', home], env, home, io(tmux, { stdin }))).rejects.toThrow(/TMUX_PANE/);
    await expect(run(['spawn', '--child', home], { ...env, TMUX_PANE: '%9' }, home, io(tmux, { stdin }))).rejects.toThrow(/session is main/);
    await expect(run(['spawn'], env, home, io(tmux, { stdin }))).rejects.toThrow(/usage: perch spawn/);
    await expect(run(['spawn', join(home, 'nope')], env, home, io(tmux, { stdin }))).rejects.toThrow(/not a directory/);
    expect(created).toEqual([]);
  });

  it('peeks at a status line and the last non-blank lines of the pane', async () => {
    const { home, env } = await machine();
    const out = await run(['peek', 'perch-aaaaaa', '-n', '2'], env, home, io(fakeTmux().tmux));
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^ID /);
    expect(lines[1]).toMatch(/^perch-aaaaaa +- +idle/);
    expect(lines.slice(2)).toEqual(['', 'line 2', 'line 3']);
    expect((await run(['peek', 'perch-aaaaaa'], env, home, io(fakeTmux().tmux))).split('\n').slice(3)).toEqual(['old', 'line 1', 'line 2', 'line 3']);
    await expect(run(['peek', 'perch-zzzzzz'], env, home, io(fakeTmux().tmux))).rejects.toThrow(/no workspace perch-zzzzzz/);
    await expect(run(['peek'], env, home, io(fakeTmux().tmux))).rejects.toThrow(/usage: perch peek/);
    await expect(run(['peek', 'perch-aaaaaa', '-n', 'x'], env, home, io(fakeTmux().tmux))).rejects.toThrow(/usage: perch peek/);
  });

  it('says a parked workspace has no pane to peek at', async () => {
    const { home, env } = await machine();
    await writeFile(
      join(home, '.perch', 'parked.json'),
      JSON.stringify([{ id: 'perch-pppppp', name: 'P', projectPath: '/w/foo', command: 'claude', machineId: 'm', createdAt: 1, parkedAt: NOW }]),
    );
    expect(await run(['peek', 'perch-pppppp'], env, home, io(fakeTmux().tmux))).toContain('parked: no pane until it is opened');
  });
});
