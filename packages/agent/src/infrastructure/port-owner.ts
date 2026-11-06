import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import type { PortOwner } from '../application/setup-machine';
import { childEnv } from './child-env';

const exec = promisify(execFile);

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' ? resolve(false) : reject(err)));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

// A listener is "ours" when it is this user's running agent. Neither ss nor lsof shows another
// user's processes without root, so a taken port with no pid we can see belongs to someone else.
async function listenerPid(port: number, platform: NodeJS.Platform): Promise<number | null> {
  try {
    if (platform === 'darwin') {
      const { stdout } = await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { env: childEnv() });
      const pid = Number(stdout.trim().split('\n')[0]);
      return pid > 0 ? pid : null;
    }
    const { stdout } = await exec('ss', ['-ltnpH', `sport = :${port}`], { env: childEnv() });
    const pid = /pid=(\d+)/.exec(stdout)?.[1];
    return pid ? Number(pid) : null;
  } catch {
    return null;
  }
}

async function isAgent(pid: number, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (platform === 'darwin') {
      const { stdout } = await exec('ps', ['-o', 'command=', '-p', String(pid)], { env: childEnv() });
      return /\bsrc\/serve\.ts\b/.test(stdout);
    }
    // The unit had the old name until setup swaps it.
    return /\/(tarfa|perch)-agent\.service\b/.test(await readFile(`/proc/${pid}/cgroup`, 'utf8'));
  } catch {
    return false;
  }
}

export async function portOwner(port: number, platform: NodeJS.Platform = process.platform): Promise<PortOwner> {
  if (await isFree(port)) return 'free';
  const pid = await listenerPid(port, platform);
  return pid !== null && (await isAgent(pid, platform)) ? 'ours' : 'other';
}
