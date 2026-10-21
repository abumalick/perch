import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileKeytermsStore } from './file-keyterms-store';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perch-keyterms-'));
  file = join(dir, 'keyterms.txt');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileKeytermsStore', () => {
  it('returns an empty list when the file is missing', async () => {
    expect(await new FileKeytermsStore(file).list()).toEqual([]);
  });

  it('reads the terms in file order', async () => {
    await writeFile(file, '# vocabulary\nClaude Code\nPerch\nHeliBoard\n', 'utf8');
    expect(await new FileKeytermsStore(file).list()).toEqual(['Claude Code', 'Perch', 'HeliBoard']);
  });

  // Read fresh on every call, like the commands and hidden-folders stores: an edit takes
  // effect on the PWA's next reconnect, with no agent restart.
  it('reflects an edit without being reconstructed', async () => {
    const store = new FileKeytermsStore(file);
    await writeFile(file, 'Perch\n', 'utf8');
    expect(await store.list()).toEqual(['Perch']);
    await writeFile(file, 'Perch\ntmux\n', 'utf8');
    expect(await store.list()).toEqual(['Perch', 'tmux']);
  });
});
