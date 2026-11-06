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
  it('writes a fresh secret to <home>/.tarfa/token with 0600 perms, and nothing beside it', async () => {
    home = await mkdtemp(join(tmpdir(), 'tarfa-token-'));
    const token = await writeHookToken(join(home, '.tarfa'));
    const path = join(home, '.tarfa', 'token');
    expect(await readFile(path, 'utf8')).toBe(token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, '.tarfa'))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(home, '.tarfa'))).toEqual(['token']);
  });

  it('is not the machine token, and changes on every start', async () => {
    home = await mkdtemp(join(tmpdir(), 'tarfa-token-'));
    expect(await writeHookToken(join(home, '.tarfa'))).not.toBe(await writeHookToken(join(home, '.tarfa')));
  });
});
