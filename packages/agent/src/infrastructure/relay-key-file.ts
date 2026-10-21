import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { generateAgentKeys, type AgentKeys } from '@perch/secure-channel';

// The agent's relay identity (~/.perch/relay-key.json), private keys included: protected like
// deploy/agent.env. Created on first use; never overwritten, since replacing it changes the
// account id and breaks every phone that pinned the old key.
export async function loadOrCreateRelayKeys(path: string): Promise<AgentKeys> {
  try {
    return parseKeys(await readFile(path, 'utf8'), path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const keys = generateAgentKeys();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return keys;
  } catch (err) {
    // Another process created it first: use theirs.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return parseKeys(await readFile(path, 'utf8'), path);
  }
}

function parseKeys(text: string, path: string): AgentKeys {
  const keyPattern = /^[A-Za-z0-9_-]{43}$/;
  const parsed = JSON.parse(text) as Partial<AgentKeys>;
  for (const pair of [parsed.x25519, parsed.ed25519]) {
    if (!pair || !keyPattern.test(pair.publicKey) || !keyPattern.test(pair.privateKey)) {
      throw new Error(`relay key file ${path} is malformed; move it aside to create a new identity`);
    }
  }
  return parsed as AgentKeys;
}
