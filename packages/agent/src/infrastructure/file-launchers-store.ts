import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LaunchersPort } from '../ports/launchers-port';
import { writeFileAtomic } from './file-lock';

export const MAX_LAUNCHERS = 20;

// Reads/writes the custom commands launched on this machine (default ~/.perch/launchers.json).
// Read fresh on every call. A missing or malformed file yields an empty list, so a bad file can
// never break the create form.
export class FileLaunchersStore implements LaunchersPort {
  // Handlers run concurrently and each write is read-modify-write, so they are queued. One
  // process owns the file, hence no file lock.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async list(): Promise<string[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      return [];
    }
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((c): c is string => typeof c === 'string' && c !== ''))]
      : [];
  }

  remember(command: string): Promise<void> {
    return this.serialized(async () => {
      const all = await this.list();
      if (all.includes(command)) return;
      await this.persist([...all, command].slice(-MAX_LAUNCHERS));
    });
  }

  forget(command: string): Promise<void> {
    return this.serialized(async () => {
      const all = await this.list();
      const rest = all.filter((c) => c !== command);
      if (rest.length !== all.length) await this.persist(rest);
    });
  }

  private serialized(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async persist(commands: string[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFileAtomic(this.filePath, JSON.stringify(commands, null, 2));
  }
}
