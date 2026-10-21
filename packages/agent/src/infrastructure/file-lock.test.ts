import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock } from './file-lock';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('withFileLock', () => {
  it('runs one holder at a time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perch-lock-'));
    dirs.push(dir);
    const path = join(dir, 'devices.json');
    let inside = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withFileLock(path, 10_000, async () => {
          most = Math.max(most, ++inside);
          await new Promise((r) => setTimeout(r, 2));
          inside -= 1;
        }),
      ),
    );
    expect(most).toBe(1);
  });

  // A holder that died leaves its lock. Every waiter that finds it stale may try to break it,
  // and only that one lock may be broken: not the one a faster waiter has just taken.
  it('lets exactly one waiter in when several find the same stale lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perch-lock-'));
    dirs.push(dir);
    const path = join(dir, 'devices.json');
    let most = 0;
    for (let round = 0; round < 150 && most <= 1; round++) {
      await writeFile(`${path}.lock`, '');
      const old = (Date.now() - 60_000) / 1000;
      await utimes(`${path}.lock`, old, old);
      let inside = 0;
      await Promise.all(
        Array.from({ length: 10 }, () =>
          withFileLock(path, 10_000, async () => {
            most = Math.max(most, ++inside);
            await new Promise((r) => setTimeout(r, 1));
            inside -= 1;
          }, 1),
        ),
      );
    }
    expect(most).toBe(1);
  });

  it('clears what a breaker that died left behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perch-lock-'));
    dirs.push(dir);
    const path = join(dir, 'devices.json');
    const old = (Date.now() - 60_000) / 1000;
    for (const leftover of [`${path}.lock`, `${path}.lock.break`]) {
      await writeFile(leftover, '');
      await utimes(leftover, old, old);
    }
    expect(await withFileLock(path, 10_000, async () => 'held', 1)).toBe('held');
  });
});

