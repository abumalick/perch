import { describe, it, expect, afterEach } from 'vitest';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPrivateFiles, securePrivateDir } from './private-dir';

let home = '';
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

describe('securePrivateDir', () => {
  it('creates the directory for its owner only', async () => {
    home = await mkdtemp(join(tmpdir(), 'perch-private-'));
    const dir = join(home, '.perch');
    await securePrivateDir(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('closes an existing directory made with a looser umask', async () => {
    home = await mkdtemp(join(tmpdir(), 'perch-private-'));
    const dir = join(home, '.perch');
    await securePrivateDir(dir);
    await chmod(dir, 0o755);
    await securePrivateDir(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
});

describe('assertPrivateFiles', () => {
  it('passes files that are missing or only their owner can use', async () => {
    home = await mkdtemp(join(tmpdir(), 'perch-private-'));
    await writeFile(join(home, 'a.json'), '{}', { mode: 0o600 });
    await expect(assertPrivateFiles([join(home, 'a.json'), join(home, 'missing.json')])).resolves.toBeUndefined();
  });

  it('refuses a secret another user could read, naming it and the fix', async () => {
    home = await mkdtemp(join(tmpdir(), 'perch-private-'));
    const path = join(home, 'relay-key.json');
    await writeFile(path, '{}');
    await chmod(path, 0o644);
    await expect(assertPrivateFiles([path])).rejects.toThrow(`run \`chmod 600 ${path}\``);
  });
});
