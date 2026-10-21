import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHookToken } from './token-file';

let home = '';
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

describe('writeHookToken', () => {
  it('writes a fresh secret to <home>/.perch/token with 0600 perms, and nothing beside it', async () => {
    home = await mkdtemp(join(tmpdir(), 'perch-token-'));
    const token = await writeHookToken(home);
    const path = join(home, '.perch', 'token');
    expect(await readFile(path, 'utf8')).toBe(token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, '.perch'))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(home, '.perch'))).toEqual(['token']);
  });

  it('is not the machine token, and changes on every start', async () => {
    home = await mkdtemp(join(tmpdir(), 'perch-token-'));
    expect(await writeHookToken(home)).not.toBe(await writeHookToken(home));
  });
});
