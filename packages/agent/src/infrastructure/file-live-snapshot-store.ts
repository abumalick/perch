import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LiveSnapshot, LiveSnapshotPort, LiveWorkspace } from '../ports/live-snapshot-port';
import { writeFileAtomic } from './file-lock';

// The live-workspace snapshot (default ~/.perch/live.json). A missing or malformed file is no
// snapshot, which recovers nothing and is rewritten on the next tick. Rewritten only when its
// content changes, since it is checked on every poll tick.
export class FileLiveSnapshotStore implements LiveSnapshotPort {
  constructor(private readonly filePath: string) {}

  async read(): Promise<LiveSnapshot | undefined> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { serverId, workspaces } = parsed as Record<string, unknown>;
    if ((serverId !== null && typeof serverId !== 'string') || !Array.isArray(workspaces)) return undefined;
    return {
      serverId,
      workspaces: workspaces.map(parseEntry).filter((e): e is LiveWorkspace => e !== undefined),
    };
  }

  async write(snapshot: LiveSnapshot): Promise<void> {
    const text = JSON.stringify(snapshot, null, 2);
    const current = await readFile(this.filePath, 'utf8').catch(() => undefined);
    if (current === text) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFileAtomic(this.filePath, text);
  }

  async remove(id: string): Promise<void> {
    const snapshot = await this.read();
    if (!snapshot) return;
    await this.write({ ...snapshot, workspaces: snapshot.workspaces.filter((w) => w.id !== id) });
  }
}

function parseEntry(value: unknown): LiveWorkspace | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof v[k] === 'string' ? (v[k] as string) : undefined);
  const id = str('id');
  const name = str('name');
  const projectPath = str('projectPath');
  // Empty for a session resurrected without its `@perch_command`; parking falls back to `claude`.
  const command = str('command');
  const machineId = str('machineId');
  const createdAt = typeof v.createdAt === 'number' ? v.createdAt : undefined;
  if (!id || !name || !projectPath || command === undefined || !machineId || createdAt === undefined) {
    return undefined;
  }
  const claudeSessionId = str('claudeSessionId');
  const parent = str('parent');
  return {
    id,
    name,
    projectPath,
    command,
    machineId,
    createdAt,
    ...(claudeSessionId ? { claudeSessionId } : {}),
    ...(parent ? { parent } : {}),
  };
}
