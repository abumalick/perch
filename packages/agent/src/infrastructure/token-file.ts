import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { securePrivateDir } from './private-dir';

// Writes a fresh hooks-only secret to ~/.perch/token, where perch-hook.sh reads it, and returns
// it. The file once held PERCH_TOKEN; keeping its path lets installed hooks carry on unchanged.
// Written to a temporary name and renamed, so a hook firing meanwhile never reads half of it.
export async function writeHookToken(home: string): Promise<string> {
  const dir = join(home, '.perch');
  await securePrivateDir(dir);
  const token = randomBytes(32).toString('base64url');
  const path = join(dir, 'token');
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, token, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  return token;
}
