import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLaunchersStore, MAX_LAUNCHERS } from './file-launchers-store';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perch-launchers-'));
  file = join(dir, 'launchers.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileLaunchersStore', () => {
  it('is empty when the file is missing', async () => {
    expect(await new FileLaunchersStore(file).list()).toEqual([]);
  });

  it('is empty when the file is malformed or not an array', async () => {
    await writeFile(file, '{nope', 'utf8');
    expect(await new FileLaunchersStore(file).list()).toEqual([]);
    await writeFile(file, '{"a":1}', 'utf8');
    expect(await new FileLaunchersStore(file).list()).toEqual([]);
  });

  it('drops non-string and empty items but keeps the rest', async () => {
    await writeFile(file, JSON.stringify(['pi', 3, '', null, 'zsh']), 'utf8');
    expect(await new FileLaunchersStore(file).list()).toEqual(['pi', 'zsh']);
  });

  it('remembers in order, once, and survives a re-read', async () => {
    const store = new FileLaunchersStore(file);
    await store.remember('pi');
    await store.remember('zsh');
    await store.remember('pi');
    expect(await new FileLaunchersStore(file).list()).toEqual(['pi', 'zsh']);
  });

  it('keeps only the newest MAX_LAUNCHERS', async () => {
    const store = new FileLaunchersStore(file);
    for (let i = 0; i < MAX_LAUNCHERS + 3; i++) await store.remember(`c${i}`);
    const list = await store.list();
    expect(list).toHaveLength(MAX_LAUNCHERS);
    expect(list[0]).toBe('c3');
    expect(list.at(-1)).toBe(`c${MAX_LAUNCHERS + 2}`);
  });

  it('forgets', async () => {
    const store = new FileLaunchersStore(file);
    await store.remember('pi');
    await store.remember('zsh');
    await store.forget('pi');
    expect(await store.list()).toEqual(['zsh']);
  });

  it('does not lose writes when remember and forget run together', async () => {
    const store = new FileLaunchersStore(file);
    await store.remember('pi');
    await store.remember('zsh');
    await Promise.all([store.forget('pi'), store.remember('a'), store.remember('b'), store.remember('c')]);
    expect((await store.list()).sort()).toEqual(['a', 'b', 'c', 'zsh']);
  });

  it('lists each command once even when the file repeats one', async () => {
    await writeFile(file, JSON.stringify(['pi', 'zsh', 'pi']), 'utf8');
    expect(await new FileLaunchersStore(file).list()).toEqual(['pi', 'zsh']);
  });
});
