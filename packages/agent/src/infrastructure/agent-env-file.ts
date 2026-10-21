import { execFile } from 'node:child_process';
import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AgentEnvPort } from '../ports/agent-env-port';

const exec = promisify(execFile);

// The agent.env the service reads: the main checkout's (deploy/run-agent.sh sources it from
// there even when a worktree is being served), wherever this CLI runs from.
export async function locateAgentEnv(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.PERCH_AGENT_ENV) return env.PERCH_AGENT_ENV;
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    const { stdout } = await exec('git', ['-C', here, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    return join(dirname(stdout.trim()), 'deploy', 'agent.env');
  } catch {
    return resolve(here, '..', '..', '..', 'deploy', 'agent.env');
  }
}

export function agentEnvFile(path: string, now: () => Date = () => new Date()): AgentEnvPort {
  return {
    path,
    read: async () => {
      try {
        return await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`no agent config at ${path}: set the agent up first (docs/DEPLOY.md), or set PERCH_AGENT_ENV`);
        }
        throw err;
      }
    },
    write: async (text) => {
      const backup = `${path}.bak-${now().toISOString().replace(/[:.]/g, '-')}`;
      await copyFile(path, backup);
      await chmod(backup, 0o600);
      await writeFile(path, text, { mode: 0o600 });
      // The mode above applies only when the file is created.
      await chmod(path, 0o600);
      return backup;
    },
  };
}
