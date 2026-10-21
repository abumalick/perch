// The self-hosted relay's account registry (~/.perch/relay/accounts.json). Only the relay process
// writes it; `perch-relay machines` goes through the relay's own HTTP API, so the registry in
// memory is always the one in force.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateAgents } from './authorize.ts';
import { EMPTY_REGISTRY, MemoryRegistry, type RegistryState } from './registry.ts';

export async function openFileRegistry(path: string): Promise<MemoryRegistry> {
  return new MemoryRegistry(await load(path), (next) => save(path, next));
}

async function load(path: string): Promise<RegistryState> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_REGISTRY;
    throw err;
  }
  try {
    // Keys other than `accounts` and `removed` (such as `seeded`) are ignored, and dropped by the next write.
    const raw = JSON.parse(text) as {
      accounts?: Record<string, { key?: unknown; addedAt?: unknown }>;
      removed?: Record<string, { key?: unknown; addedAt?: unknown; removedAt?: unknown }>;
    };
    const keys = validateAgents(Object.fromEntries(Object.entries(raw.accounts ?? {}).map(([a, e]) => [a, e.key])));
    const accounts: RegistryState['accounts'] = {};
    for (const [account, key] of Object.entries(keys)) accounts[account] = { key, addedAt: String(raw.accounts![account]!.addedAt ?? '') };
    const removedKeys = validateAgents(Object.fromEntries(Object.entries(raw.removed ?? {}).map(([a, e]) => [a, e.key])));
    const removed: NonNullable<RegistryState['removed']> = {};
    for (const [account, key] of Object.entries(removedKeys)) {
      const entry = raw.removed![account]!;
      removed[account] = { key, addedAt: String(entry.addedAt ?? ''), removedAt: String(entry.removedAt ?? '') };
    }
    return { accounts, removed };
  } catch {
    throw new Error(`relay registry ${path} is malformed; fix or move it aside`);
  }
}

async function save(path: string, state: RegistryState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Written whole and renamed into place, so a crash never leaves half a registry.
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}
