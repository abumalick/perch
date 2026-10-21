import { chmod, mkdir, stat } from 'node:fs/promises';
import { exposedFiles } from '../application/private-files';

// ~/.perch holds the agent's secrets: its owner's alone, whatever umask created it.
export async function securePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

// Throws naming every secret file another user could read or change; a missing one is fine (it
// is created 0600 when first written).
export async function assertPrivateFiles(paths: string[]): Promise<void> {
  const found: Array<{ path: string; mode: number }> = [];
  for (const path of paths) {
    try {
      found.push({ path, mode: (await stat(path)).mode });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const problems = exposedFiles(found);
  if (problems.length > 0) throw new Error(problems.join('\n'));
}
