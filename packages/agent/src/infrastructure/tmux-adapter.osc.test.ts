import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TmuxAdapter } from './tmux-adapter';
import { unparkWorkspace } from '../application/unpark-workspace';

// Runs only against a tmux built with the OSC 7501 patch (deploy/tmux-osc7501): set
// TARFA_TMUX_OSC to its binary. A stock tmux keeps no program status, so without it this skips.
//
// ISOLATION: every tmux call carries `-S <sandbox socket>`, which beats $TMUX, and the server
// gets `-f /dev/null`, so neither the user's server nor their plugins are ever reached.
const BINARY = process.env.TARFA_TMUX_OSC;
const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.tmp');

let sandbox: string;
let socket: string;
let adapter: TmuxAdapter;

const t = (args: string[]) => exec(BINARY!, ['-S', socket, ...args]).then((r) => r.stdout.replace(/\n$/, ''));

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!BINARY)('TmuxAdapter against a tmux patched for OSC 7501', () => {
  beforeAll(async () => {
    await mkdir(ROOT, { recursive: true });
    sandbox = await mkdtemp(join(ROOT, 'osc-'));
    socket = join(sandbox, 's');
    adapter = new TmuxAdapter({ binary: BINARY, socket, config: '/dev/null' });
  });

  const named = async (name: string) => (await adapter.listSessions('perch-')).find((s) => s.name === name);

  afterAll(async () => {
    if (socket?.startsWith(`${sandbox}/`)) await t(['kill-server']).catch(() => undefined);
    if (sandbox) await rm(sandbox, { recursive: true, force: true });
  });

  it('lists the program status a pane reports', async () => {
    await adapter.createSession({ name: 'perch-osc1', cwd: sandbox, command: 'sh' });
    await t(['send-keys', '-t', 'perch-osc1', "printf '\\033]7501;state=working:app=claude-code\\033\\\\'", 'Enter']);
    await until(async () => (await named('perch-osc1'))?.program?.state === 'working');
    const session = await named('perch-osc1');
    expect(session?.program?.changedAt).toBeGreaterThan(1_000_000_000_000);
    expect(session?.title).not.toBe('');
  });

  it('locks a pane title against the program but not against select-pane', async () => {
    expect(await adapter.supportsTitleLock()).toBe(true);
    await adapter.createSession({ name: 'perch-osc2', cwd: sandbox, command: 'sh' });
    await adapter.lockPaneTitle('perch-osc2');
    await adapter.setPaneTitle('perch-osc2', '✳ ours');
    await t(['send-keys', '-t', 'perch-osc2', "printf '\\033]2;theirs\\007\\033]7501;state=done\\033\\\\'", 'Enter']);
    await until(async () => (await named('perch-osc2'))?.program?.state === 'done');
    expect((await named('perch-osc2'))?.title).toBe('✳ ours');
  });

  it('an unparked workspace keeps its parked name when the resumed program writes a title', async () => {
    const record = { id: 'perch-osc3', name: 'audit workflows #1077', projectPath: sandbox, command: 'sh', machineId: 'm', createdAt: 1, parkedAt: 2 };
    const statuses: string[] = [];
    const result = await unparkWorkspace(
      {
        parked: { get: async () => record, remove: async () => {} },
        tmux: adapter,
        isDirectory: async () => true,
        status: { set: (_id, status) => void statuses.push(status) },
      },
      record.id,
    );
    expect(result).toBe('unparked');
    await t(['send-keys', '-t', 'perch-osc3', "printf '\\033]2;perch-osc3\\007\\033]7501;state=done\\033\\\\'", 'Enter']);
    await until(async () => (await named('perch-osc3'))?.program?.state === 'done');
    expect((await named('perch-osc3'))?.title).toBe('✳ audit workflows #1077');
  });
});
