import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { securePrivateDir } from './private-dir';

// Writes a fresh hooks-only secret to ~/.tarfa/token, where tarfa-hook.sh reads it, and returns
// it. The file once held the machine token; keeping its path let installed hooks carry on unchanged.
// Written to a temporary name and renamed, so a hook firing meanwhile never reads half of it.
export async function writeHookToken(dir: string): Promise<string> {
  await securePrivateDir(dir);
  const token = randomBytes(32).toString('base64url');
  const path = join(dir, 'token');
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, token, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  return token;
}
