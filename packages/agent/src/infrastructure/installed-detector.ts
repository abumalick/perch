import { execFile } from 'node:child_process';
import { childEnv } from './child-env';

export const KNOWN_CLIS = ['claude', 'codex'];

export async function detectInstalled(
  names: string[],
  resolve: (name: string) => Promise<boolean>,
): Promise<string[]> {
  const found = await Promise.all(names.map(resolve));
  return names.filter((_, i) => found[i]);
}

// Only the shell's own "not found" (exit 1) means absent. Anything else — a profile that
// errors, a timeout, a shell that will not start — says nothing about the CLI, and hiding Claude
// on that evidence would quietly turn the form's default into Bash.
export function loginShellResolver(shell = process.env.SHELL || '/bin/sh'): (name: string) => Promise<boolean> {
  return (name) =>
    new Promise((resolve) => {
      execFile(shell, ['-lc', `command -v ${name}`], { env: childEnv(), timeout: 5000 }, (err) =>
        resolve(!err || (err as { code?: unknown }).code !== 1),
      );
    });
}
