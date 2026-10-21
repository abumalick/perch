import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountId, deviceFingerprint, generateDeviceKeys, parsePairingLink } from '@perch/secure-channel';
import { FileDeviceStore } from './infrastructure/file-device-store';
import { enrolDevice, enrolmentMode } from './application/device-roster';
import { run } from './cli';

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

describe('perch relay-key', () => {
  it('creates the relay identity and prints only what the phone and the relay need', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-cli-home-'));
    tmpDirs.push(home);
    const env = {
      PERCH_MACHINE_ID: 'test',
      PERCH_RELAY_URLS: 'wss://relay.example.com/, wss://relay-dev.example.com',
      PERCH_AGENT_ENV: join(home, 'agent.env'),
    };
    const out = await run(['relay-key'], env, home);
    const keys = JSON.parse(await readFile(join(home, '.perch', 'relay-key.json'), 'utf8')) as {
      x25519: { publicKey: string; privateKey: string };
      ed25519: { publicKey: string; privateKey: string };
    };
    const account = accountId(keys.ed25519.publicKey);
    expect(out).toContain(`agent key: ${keys.x25519.publicKey}`);
    expect(out).toContain(`phone URL: wss://relay.example.com/${account}`);
    expect(out).toContain(`phone URL: wss://relay-dev.example.com/${account}`);
    expect(out).not.toContain('AGENTS');
    expect(out).not.toContain(keys.x25519.privateKey);
    expect(out).not.toContain(keys.ed25519.privateKey);
    expect(await run(['relay-key'], env, home)).toBe(out);
  });

  // A shell inside a workspace no longer inherits the agent's env, and a stale copy of it once
  // printed a relay the agent had long dropped: the CLI reads what the service reads.
  it('reads the relays from the agent.env the service reads, over an inherited environment', async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-cli-home-'));
    tmpDirs.push(home);
    const envPath = join(home, 'agent.env');
    await writeFile(envPath, 'PERCH_MACHINE_ID=box\nPERCH_RELAY_URLS=wss://relay.example.com\n');
    const out = await run(['relay-key'], { PERCH_RELAY_URLS: 'wss://stale.example.com', PERCH_AGENT_ENV: envPath }, home);
    expect(out).toMatch(/phone URL: wss:\/\/relay\.example\.com\//);
    expect(out).not.toContain('stale.example.com');
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

  it('warns when there are more devices than a relay takes in its policy', async () => {
    const { home, env, store } = await withPhones();
    await store.update((r) => ({ ...r, revoked: Array.from({ length: 257 }, (_, i) => ({ ...r.devices[0]!, id: `r${i}`, revokedAt: r.devices[0]!.enrolledAt })) }));
    expect(await run(['devices'], env, home)).toMatch(/257 revoked.*256/);
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

describe('perch pair / connect (arguments and agent.env)', () => {
  async function machine(envText: string) {
    const home = await mkdtemp(join(tmpdir(), 'perch-pair-home-'));
    tmpDirs.push(home);
    const envPath = join(home, 'agent.env');
    await writeFile(envPath, envText);
    return { home, env: { PERCH_AGENT_ENV: envPath } };
  }
  const base = 'PERCH_MACHINE_ID=box\nPERCH_TOKEN=t\n';

  it('mints a pairing link for the one relay a phone can reach, reading the agent.env the service reads', async () => {
    const { home, env } = await machine(`${base}PERCH_RELAY_URLS=ws://127.0.0.1:8450,wss://relay.example\nPERCH_PWA_ORIGIN=https://pwa.example:8443\n`);
    const out = await run(['pair'], env, home);
    const link = out.split('\n').find((line) => line.startsWith('https://'))!;
    const pairing = parsePairingLink(link)!;
    expect(pairing.url.startsWith('wss://relay.example/')).toBe(true);
    expect(pairing.name).toBe('box');
    const stored = JSON.parse(await readFile(join(home, '.perch', 'pairing.json'), 'utf8')) as Array<{ secret: string }>;
    expect(stored.map((p) => p.secret)).toEqual([pairing.secret]);
    expect(out).toContain('10 minutes');
    // The phone shows the same fingerprint before it pairs, to compare by eye.
    expect(out).toContain(`machine key ${deviceFingerprint(pairing.agentKey)};`);
  });

  it('hands the phone the PERCH_DEFAULT_PATH agent.env sets', async () => {
    const { home, env } = await machine(`${base}PERCH_RELAY_URLS=wss://relay.example\nPERCH_PWA_ORIGIN=https://pwa.example:8443\nPERCH_DEFAULT_PATH=/home/u/workspace\n`);
    const out = await run(['pair'], env, home);
    expect(parsePairingLink(out.split('\n').find((line) => line.startsWith('https://'))!)!.defaultPath).toBe('/home/u/workspace');
  });

  it('names the pairing after the host when the machine id is the generic "local"', async () => {
    const { home, env } = await machine('PERCH_MACHINE_ID=local\nPERCH_TOKEN=t\nPERCH_RELAY_URLS=wss://relay.example\nPERCH_PWA_ORIGIN=https://pwa.example:8443\n');
    const out = await run(['pair'], env, home);
    const pairing = parsePairingLink(out.split('\n').find((line) => line.startsWith('https://'))!)!;
    expect(pairing.name).toBe(hostname().split('.')[0]);
  });

  it('asks which relay when there are several, and takes --relay and --pwa', async () => {
    const { home, env } = await machine(`${base}PERCH_RELAY_URLS=wss://a.example,wss://b.example\n`);
    await expect(run(['pair'], env, home)).rejects.toThrow(/--relay/);
    await expect(run(['pair', '--relay', 'wss://b.example'], env, home)).rejects.toThrow(/--pwa/);
    const out = await run(['pair', '--relay', 'wss://b.example', '--pwa', 'https://pwa.example/ignored/path'], env, home);
    expect(out).toContain('https://pwa.example/#pair?');
  });

  it('refuses a connect without a well-formed join key', async () => {
    const { home, env } = await machine(base);
    await expect(run(['connect', 'wss://relay.example'], env, home)).rejects.toThrow(/usage/);
    await expect(run(['connect', 'wss://relay.example', '--key', 'nope'], env, home)).rejects.toThrow(/join key/);
    await expect(run(['connect', 'wss://relay.example'], { ...env, PERCH_JOIN_KEY: 'nope' }, home)).rejects.toThrow(/join key/);
  });
});
