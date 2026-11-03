import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ProcessAncestry } from '../ports/process-ancestry-port';
import { childEnv } from './child-env';

const exec = promisify(execFile);
const MAX_GENERATIONS = 64;

type ParentOf = (pid: number) => Promise<number | null>;

// The command name in /proc/<pid>/stat is parenthesised and may itself hold spaces and
// parentheses (`(tmux: server)`), so the fields are read after the last `)`.
export async function procParentOf(
  pid: number,
  read: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<number | null> {
  try {
    const stat = await read(`/proc/${pid}/stat`);
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1]);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

export async function psParentOf(pid: number): Promise<number | null> {
  try {
    const { stdout } = await exec('ps', ['-o', 'ppid=', '-p', String(pid)], { env: childEnv() });
    const ppid = Number(stdout.trim());
    return stdout.trim() !== '' && Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

export class ProcAncestry implements ProcessAncestry {
  constructor(private readonly parentOf: ParentOf = process.platform === 'linux' ? procParentOf : psParentOf) {}

  async isAncestor(ancestorPid: number, pid: number): Promise<boolean> {
    let current = pid;
    for (let step = 0; step < MAX_GENERATIONS && current > 1; step++) {
      const parent = await this.parentOf(current);
      if (parent === null) return false;
      if (parent === ancestorPid) return true;
      current = parent;
    }
    return false;
  }
}
