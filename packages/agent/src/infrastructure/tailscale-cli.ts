import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ServeConfig, TailscaleStatus } from '../application/setup-machine';
import { TailscaleOperatorError, type TailscalePort } from '../ports/tailscale-port';
import { childEnv } from './child-env';

export type Exec = (args: string[]) => Promise<{ stdout: string }>;

const run = promisify(execFile);
const systemExec: Exec = (args) => run('tailscale', args, { env: childEnv(), timeout: 30_000 });

const NEEDS_OPERATOR = /access denied|--operator|permission denied/i;

export function tailscaleCli(exec: Exec = systemExec): TailscalePort {
  return {
    async status() {
      try {
        return JSON.parse((await exec(['status', '--json'])).stdout) as TailscaleStatus;
      } catch {
        return null;
      }
    },
    async serveStatus() {
      try {
        const { stdout } = await exec(['serve', 'status', '--json']);
        return stdout.trim() === '' ? {} : (JSON.parse(stdout) as ServeConfig);
      } catch {
        return null;
      }
    },
    async serve({ port, path, target, funnel }) {
      const args = [funnel ? 'funnel' : 'serve', '--bg', `--https=${port}`, ...(path === '/' ? [] : [`--set-path=${path}`]), target];
      try {
        await exec(args);
      } catch (err) {
        const stderr = String((err as { stderr?: string }).stderr ?? '').trim();
        if (NEEDS_OPERATOR.test(stderr)) throw new TailscaleOperatorError(stderr);
        throw new Error(`tailscale ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
      }
    },
  };
}
