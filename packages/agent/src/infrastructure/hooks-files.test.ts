import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { hooksFiles } from './hooks-files';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function home() {
  const dir = await mkdtemp(join(tmpdir(), 'perch-hooks-home-'));
  homes.push(dir);
  return dir;
}

describe('hooksFiles', () => {
  it('is not current until installed, then is', async () => {
    const h = await home();
    const hooks = hooksFiles(h, HOOKS_DIR, 8787);
    expect(await hooks.current()).toBe(false);
    expect(await hooks.install()).toEqual({ codex: false });
    expect(await hooks.current()).toBe(true);
  });

  it('stays current when Claude Code rewrites its settings with sorted keys and other whitespace', async () => {
    const h = await home();
    const hooks = hooksFiles(h, HOOKS_DIR, 8787);
    await hooks.install();
    const path = join(h, '.claude', 'settings.json');
    const sortKeys = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)])) : v;
    await writeFile(path, `${JSON.stringify(sortKeys(JSON.parse(await readFile(path, 'utf8'))), null, 2)}\n`);
    expect(await hooks.current()).toBe(true);
  });

  it('stays current when the user added a hook of their own after Perch\'s', async () => {
    const h = await home();
    const hooks = hooksFiles(h, HOOKS_DIR, 8787);
    await hooks.install();
    const path = join(h, '.claude', 'settings.json');
    const settings = JSON.parse(await readFile(path, 'utf8')) as { hooks: Record<string, unknown[]> };
    settings.hooks.PreToolUse!.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash ~/mine.sh' }] });
    await writeFile(path, JSON.stringify(settings));
    expect(await hooks.current()).toBe(true);
  });

  it('is not current for another hooks port, or a stale script', async () => {
    const h = await home();
    await hooksFiles(h, HOOKS_DIR, 8787).install();
    expect(await hooksFiles(h, HOOKS_DIR, 8789).current()).toBe(false);
    await writeFile(join(h, '.perch', 'perch-guard.sh'), 'old\n');
    expect(await hooksFiles(h, HOOKS_DIR, 8787).current()).toBe(false);
  });

  it('writes Codex hooks only where Codex is installed', async () => {
    const h = await home();
    await mkdir(join(h, '.codex'));
    const hooks = hooksFiles(h, HOOKS_DIR, 8787);
    expect(await hooks.install()).toEqual({ codex: true });
    expect(await readFile(join(h, '.codex', 'hooks.json'), 'utf8')).toContain('perch-hook.sh');
    expect(await hooks.current()).toBe(true);
  });
});
