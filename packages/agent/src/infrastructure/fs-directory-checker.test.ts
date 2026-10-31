import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fsIsDirectory, fsResolveDirectory } from './fs-directory-checker';

describe('fsIsDirectory', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'perch-dircheck-'));
    file = join(dir, 'a-file.txt');
    await writeFile(file, 'hi', 'utf8');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is true for an existing directory', async () => {
    expect(await fsIsDirectory(dir)).toBe(true);
  });

  it('is false for an existing file', async () => {
    expect(await fsIsDirectory(file)).toBe(false);
  });

  it('is false for a missing path', async () => {
    expect(await fsIsDirectory(join(dir, 'does-not-exist'))).toBe(false);
  });
});

describe('fsResolveDirectory', () => {
  let base: string;

  beforeAll(async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.tmp');
    await mkdir(root, { recursive: true });
    base = await realpath(await mkdtemp(join(root, 'resolve-dir-')));
    await mkdir(join(base, 'real'));
    await symlink(join(base, 'real'), join(base, 'link'));
    await writeFile(join(base, 'file'), 'x');
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('resolves a relative path against the given cwd, and follows symlinks', async () => {
    expect(await fsResolveDirectory(base)('link')).toBe(join(base, 'real'));
    expect(await fsResolveDirectory('/elsewhere')(join(base, 'real'))).toBe(join(base, 'real'));
  });

  it('is null for a missing path or a file', async () => {
    expect(await fsResolveDirectory(base)('nope')).toBeNull();
    expect(await fsResolveDirectory(base)('file')).toBeNull();
  });
});
