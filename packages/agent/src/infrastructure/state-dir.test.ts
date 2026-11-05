import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateStateDir, resolveAgentKeyPath, resolveStateDir } from './state-dir';
import { loadOrCreateAgentKeys } from './agent-key-file';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tarfa-state-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const legacy = () => join(home, '.perch');
const current = () => join(home, '.tarfa');

async function legacyWithKey(): Promise<string> {
  await mkdir(legacy(), { mode: 0o700 });
  const keys = await loadOrCreateAgentKeys(join(legacy(), 'relay-key.json'));
  await writeFile(join(legacy(), 'devices.json'), '{"devices":[]}', { mode: 0o600 });
  return keys.x25519.publicKey;
}

describe('migrateStateDir', () => {
  it('moves ~/.perch to ~/.tarfa, leaves a link, and keeps the same agent key', async () => {
    const before = await legacyWithKey();
    expect(await migrateStateDir(home)).toBe('moved');
    expect(await readlink(legacy())).toBe('.tarfa');
    expect((await stat(current())).mode & 0o777).toBe(0o700);
    expect(await readFile(join(current(), 'devices.json'), 'utf8')).toBe('{"devices":[]}');
    const after = await loadOrCreateAgentKeys(resolveAgentKeyPath(current()));
    expect(after.x25519.publicKey).toBe(before);
    expect(resolveAgentKeyPath(current())).toBe(join(current(), 'agent-key.json'));
    // An agent from before the rename, run again, still finds the same key.
    expect(await readlink(join(current(), 'relay-key.json'))).toBe('agent-key.json');
    expect((await loadOrCreateAgentKeys(join(legacy(), 'relay-key.json'))).x25519.publicKey).toBe(before);
  });

  it('refuses a dangling ~/.perch link instead of starting empty', async () => {
    await symlink(join(home, 'gone'), legacy());
    await expect(migrateStateDir(home)).rejects.toThrow(/link to nothing usable/);
    await expect(stat(current())).rejects.toThrow();
  });

  it('is a no-op the second time, and leaves no lock behind', async () => {
    await legacyWithKey();
    await migrateStateDir(home);
    expect(await migrateStateDir(home)).toBe('unchanged');
    expect(await readlink(legacy())).toBe('.tarfa');
    await expect(stat(join(home, '.tarfa-migrate.lock'))).rejects.toThrow();
  });

  it('creates nothing on a machine that has neither', async () => {
    expect(await migrateStateDir(home)).toBe('unchanged');
    await expect(stat(current())).rejects.toThrow();
    await expect(stat(legacy())).rejects.toThrow();
  });

  it('refuses to start when both hold something, naming both', async () => {
    await legacyWithKey();
    await mkdir(current());
    await writeFile(join(current(), 'status.json'), '{}');
    await expect(migrateStateDir(home)).rejects.toThrow(/both .*\.perch and .*\.tarfa exist/);
    expect((await stat(join(legacy(), 'relay-key.json'))).isFile()).toBe(true);
  });

  it('moves over an empty ~/.tarfa left behind by a half run', async () => {
    const before = await legacyWithKey();
    await mkdir(current());
    expect(await migrateStateDir(home)).toBe('moved');
    expect((await loadOrCreateAgentKeys(resolveAgentKeyPath(current()))).x25519.publicKey).toBe(before);
  });

  it('refuses a ~/.perch link that points somewhere other than ~/.tarfa', async () => {
    const elsewhere = join(home, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, legacy());
    await mkdir(current());
    await expect(migrateStateDir(home)).rejects.toThrow(/will not merge/);
  });

  it('moves a ~/.perch that is a link of the user own, keeping its target', async () => {
    const elsewhere = join(home, 'elsewhere');
    await mkdir(elsewhere);
    await loadOrCreateAgentKeys(join(elsewhere, 'relay-key.json'));
    await symlink(elsewhere, legacy());
    expect(await migrateStateDir(home)).toBe('moved');
    expect(await realpath(current())).toBe(await realpath(elsewhere));
    expect((await stat(join(elsewhere, 'agent-key.json'))).isFile()).toBe(true);
  });

  it('renames a key left under its old name in an already moved directory', async () => {
    await mkdir(current());
    await loadOrCreateAgentKeys(join(current(), 'relay-key.json'));
    await migrateStateDir(home);
    expect(resolveAgentKeyPath(current())).toBe(join(current(), 'agent-key.json'));
  });

  it('refuses when both key names exist', async () => {
    await mkdir(current());
    await loadOrCreateAgentKeys(join(current(), 'relay-key.json'));
    await loadOrCreateAgentKeys(join(current(), 'agent-key.json'));
    await expect(migrateStateDir(home)).rejects.toThrow(/both agent-key.json and relay-key.json/);
  });
});

describe('resolveStateDir', () => {
  it('reads a ~/.perch not moved yet, and creates nothing', async () => {
    await legacyWithKey();
    expect(resolveStateDir(home)).toBe(legacy());
    expect(resolveAgentKeyPath(legacy())).toBe(join(legacy(), 'relay-key.json'));
    await expect(stat(current())).rejects.toThrow();
  });

  it('prefers ~/.tarfa once it exists, and defaults to it', async () => {
    expect(resolveStateDir(home)).toBe(current());
    await legacyWithKey();
    await migrateStateDir(home);
    expect(resolveStateDir(home)).toBe(current());
  });
});
