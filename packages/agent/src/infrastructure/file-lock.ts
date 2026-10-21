import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 5000;

// Holds `<path>.lock` for the duration of `fn`, for a file two processes update (the agent and
// the `perch` CLI). A holder that died leaves its lock behind; nothing holds it longer than one
// write, so one older than `staleLockMs` is broken.
export async function withFileLock<T>(path: string, staleLockMs: number, fn: () => Promise<T>, retryMs = LOCK_RETRY_MS): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await (await open(lockPath, 'wx', 0o600)).close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if ((await ageMs(lockPath)) >= staleLockMs && (await breakStaleLock(lockPath, staleLockMs))) continue;
    if (Date.now() > deadline) throw new Error(`${path} is locked (${lockPath})`);
    await new Promise((r) => setTimeout(r, retryMs));
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

async function ageMs(path: string): Promise<number> {
  return stat(path).then((s) => Date.now() - s.mtimeMs, () => 0);
}

// Breaking a stale lock is check-then-delete, so it is done under a second lock: two waiters that
// both saw the stale lock would otherwise each delete "it", the second deleting the lock the
// first had just taken, and both would write. Under `<lock>.break` the age is read again, so a
// lock taken since is left alone. Only a breaker that dies inside these few calls leaves the
// break lock behind; it is cleared once stale, which is the one step left racy, and needs a
// breaker to have died first. False when another waiter is breaking it.
async function breakStaleLock(lockPath: string, staleLockMs: number): Promise<boolean> {
  const breakPath = `${lockPath}.break`;
  try {
    await (await open(breakPath, 'wx', 0o600)).close();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if ((await ageMs(breakPath)) >= staleLockMs) await unlink(breakPath).catch(() => undefined);
    return false;
  }
  try {
    if ((await ageMs(lockPath)) >= staleLockMs) await unlink(lockPath).catch(() => undefined);
    return true;
  } finally {
    await unlink(breakPath).catch(() => undefined);
  }
}

// Written whole and renamed into place, so a reader never sees half a file.
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}
