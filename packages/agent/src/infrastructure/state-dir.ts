import { existsSync, lstatSync, statSync } from 'node:fs';
import { lstat, readdir, realpath, rename, rmdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock } from './file-lock';

export const STATE_DIR = '.tarfa';
// Where the state lived before the rename. The agent moves it and leaves a symlink here for one
// release, so an older CLI or hook still finds it.
export const LEGACY_STATE_DIR = '.perch';
export const AGENT_KEY_FILE = 'agent-key.json';
// The agent key's name when relays existed; renamed in place by migrateStateDir.
export const LEGACY_AGENT_KEY_FILE = 'relay-key.json';

// The directory a process that must not move anything reads (the CLI, while an older agent may
// still run): ~/.tarfa once it exists, else a ~/.perch not moved yet, else ~/.tarfa.
export function resolveStateDir(home: string): string {
  const current = join(home, STATE_DIR);
  if (existsSync(current)) return current;
  const legacy = join(home, LEGACY_STATE_DIR);
  if (isRealDir(legacy)) return legacy;
  return current;
}

// The agent key in `dir`, under its old name when the new one is absent: a key that exists must
// never be taken for missing, since creating a new one breaks every phone that pinned it.
export function resolveAgentKeyPath(dir: string): string {
  const current = join(dir, AGENT_KEY_FILE);
  if (existsSync(current)) return current;
  const legacy = join(dir, LEGACY_AGENT_KEY_FILE);
  return existsSync(legacy) ? legacy : current;
}

export type MigrationResult = 'moved' | 'unchanged';

// Moves ~/.perch to ~/.tarfa (one rename(2), so atomic on one filesystem), leaves ~/.perch as a
// symlink to it, and renames the agent key. Run by the agent at startup before it reads anything,
// and by setup once the old service is stopped. It never merges: when both hold something it
// refuses, since starting on an empty ~/.tarfa while ~/.perch holds the key would make a new key.
// The lock sits beside both directories, because taking it must not create either.
export async function migrateStateDir(home: string): Promise<MigrationResult> {
  const current = join(home, STATE_DIR);
  const legacy = join(home, LEGACY_STATE_DIR);
  return withFileLock(join(home, '.tarfa-migrate'), 60_000, async () => {
    let result: MigrationResult = 'unchanged';
    const old = await kind(legacy);
    if (old === 'dir') {
      const now = await kind(current);
      if (now === 'dir' && (await readdir(current)).length === 0) await rmdir(current);
      else if (now !== 'absent') throw bothExist(current, legacy);
      await rename(legacy, current);
      await symlink(STATE_DIR, legacy);
      result = 'moved';
    } else if (old === 'link') {
      const target = await realpath(legacy).catch(() => null);
      if ((await kind(current)) === 'absent') {
        // A ~/.perch kept elsewhere through a link of the user's own: the link moves, not its target.
        if (target !== null && isRealDir(target)) {
          await rename(legacy, current);
          await symlink(STATE_DIR, legacy);
          result = 'moved';
        }
      } else if (target !== (await realpath(current))) {
        throw bothExist(current, legacy);
      }
    }
    if ((await kind(current)) !== 'absent') await renameLegacyKey(current);
    return result;
  });
}

async function renameLegacyKey(dir: string): Promise<void> {
  const legacyKey = join(dir, LEGACY_AGENT_KEY_FILE);
  const key = join(dir, AGENT_KEY_FILE);
  if ((await kind(legacyKey)) === 'absent') return;
  if ((await kind(key)) !== 'absent') {
    throw new Error(`${dir} holds both ${AGENT_KEY_FILE} and ${LEGACY_AGENT_KEY_FILE}: keep the one phones pinned (tarfa pair prints its fingerprint) and move the other away`);
  }
  await rename(legacyKey, key);
}

function bothExist(current: string, legacy: string): Error {
  return new Error(
    `both ${legacy} and ${current} exist, and ${legacy} is not a link to ${current}: the agent will not merge them. Keep the one that holds the agent key, move the other away, and start again`,
  );
}

async function kind(path: string): Promise<'absent' | 'dir' | 'link' | 'other'> {
  try {
    const s = await lstat(path);
    return s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : 'other';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw err;
  }
}

function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory() || statSync(path).isDirectory();
  } catch {
    return false;
  }
}
