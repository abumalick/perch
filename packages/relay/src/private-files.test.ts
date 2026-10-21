import { describe, it, expect, afterEach } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securePrivateConfig, writePrivateConfig } from './private-files.ts';

let home = '';
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

describe('securePrivateConfig', () => {
  it("closes the config's directory to its owner, and accepts files only the owner can use", async () => {
    home = await mkdtemp(join(tmpdir(), 'perch-relay-private-'));
    const dir = join(home, 'relay');
    await securePrivateConfig(join(dir, 'config.json'), []);
    await chmod(dir, 0o755);
    await writeFile(join(dir, 'config.json'), '{}', { mode: 0o600 });
    await securePrivateConfig(join(dir, 'config.json'), [join(dir, 'accounts.json')]);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('refuses a config or registry another user could read, naming it and the fix', async () => {
    home = await mkdtemp(join(tmpdir(), 'perch-relay-private-'));
    const accounts = join(home, 'accounts.json');
    await writeFile(accounts, '{}');
    await chmod(accounts, 0o644);
    await expect(securePrivateConfig(join(home, 'config.json'), [accounts])).rejects.toThrow(
      `${accounts} is readable or writable by other users (mode 644): run \`chmod 600 ${accounts}\``,
    );
  });
});

describe('writePrivateConfig', () => {
  it("creates the config's directory, closed to its owner, and writes a file only the owner can use", async () => {
    home = await mkdtemp(join(tmpdir(), 'perch-relay-private-'));
    const dir = join(home, '.perch', 'relay');
    await writePrivateConfig(join(dir, 'config.json'), '{"joinKey":"k"}');
    expect(await readFile(join(dir, 'config.json'), 'utf8')).toBe('{"joinKey":"k"}');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'config.json'))).mode & 0o777).toBe(0o600);
  });
});
