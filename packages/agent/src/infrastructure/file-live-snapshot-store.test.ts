import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLiveSnapshotStore } from './file-live-snapshot-store';
import type { LiveSnapshot } from '../ports/live-snapshot-port';

const snapshot: LiveSnapshot = {
  serverId: '123:456',
  workspaces: [
    {
      id: 'perch-a',
      name: 'Fix login redirect',
      projectPath: '/home/u/workspace/foo',
      command: 'claude',
      machineId: 'dev',
      createdAt: 100,
      claudeSessionId: 'sess-1',
    },
  ],
};

describe('FileLiveSnapshotStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perch-live-'));
    file = join(dir, 'live.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads back what it wrote', async () => {
    const store = new FileLiveSnapshotStore(file);
    await store.write(snapshot);
    expect(await store.read()).toEqual(snapshot);
  });

  it('has no snapshot when the file is missing or malformed', async () => {
    const store = new FileLiveSnapshotStore(file);
    expect(await store.read()).toBeUndefined();
    writeFileSync(file, '{not json');
    expect(await store.read()).toBeUndefined();
    writeFileSync(file, JSON.stringify({ workspaces: [] }));
    expect(await store.read()).toBeUndefined();
  });

  it('drops an entry missing a required field', async () => {
    writeFileSync(file, JSON.stringify({ serverId: null, workspaces: [{ id: 'perch-a' }, snapshot.workspaces[0]] }));
    expect(await new FileLiveSnapshotStore(file).read()).toEqual({ serverId: null, workspaces: snapshot.workspaces });
  });

  it('does not rewrite an unchanged snapshot', async () => {
    const store = new FileLiveSnapshotStore(file);
    await store.write(snapshot);
    const before = statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await store.write(structuredClone(snapshot));
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it('removes one workspace', async () => {
    const store = new FileLiveSnapshotStore(file);
    await store.write(snapshot);
    await store.remove('perch-a');
    expect(await store.read()).toEqual({ serverId: '123:456', workspaces: [] });
    await store.remove('perch-missing');
  });

  it('keeps a parent link, and drops one that is not a non-empty string', async () => {
    const store = new FileLiveSnapshotStore(file);
    const withParent = { ...snapshot, workspaces: [{ ...snapshot.workspaces[0]!, parent: 'perch-p' }] };
    await store.write(withParent);
    expect(await store.read()).toEqual(withParent);
    writeFileSync(
      file,
      JSON.stringify({ ...snapshot, workspaces: [{ ...snapshot.workspaces[0]!, parent: 7 }, { ...snapshot.workspaces[0]!, parent: '' }] }),
    );
    expect((await store.read())?.workspaces).toEqual([snapshot.workspaces[0], snapshot.workspaces[0]]);
  });
});
