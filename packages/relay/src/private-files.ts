// The relay's config holds its join and admin keys, and its registry which machines it serves:
// they are their owner's alone. The directory is closed at startup, and a file another user could
// read or change stops the relay with the fix.
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// For the CLI, which may write the config before the relay has ever started.
export async function writePrivateConfig(configPath: string, text: string): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, text, { mode: 0o600 });
}

export async function securePrivateConfig(configPath: string, others: string[]): Promise<void> {
  const dir = dirname(configPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const problems: string[] = [];
  for (const path of [configPath, ...others]) {
    let mode: number;
    try {
      mode = (await stat(path)).mode;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if ((mode & 0o077) !== 0) {
      problems.push(`${path} is readable or writable by other users (mode ${(mode & 0o777).toString(8)}): run \`chmod 600 ${path}\``);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
}
