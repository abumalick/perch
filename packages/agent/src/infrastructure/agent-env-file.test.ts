import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentEnvFile } from './agent-env-file';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('agentEnvFile', () => {
  // agent.env holds PERCH_TOKEN. A copy of the example keeps the checkout's 0664, and writeFile's
  // mode applies only to a file it creates.
  it('leaves an existing agent.env, and its backup, readable by its owner alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'perch-agent-env-'));
    dirs.push(dir);
    const path = join(dir, 'agent.env');
    await writeFile(path, 'PERCH_TOKEN=t\n');
    await chmod(path, 0o664);
    const backup = await agentEnvFile(path).write('PERCH_TOKEN=t\nPERCH_RELAY_URLS=wss://relay.example\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toHaveLength(2);
  });
});
