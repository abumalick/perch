import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentServicePort } from '../ports/agent-service-port';
import { childEnv } from './child-env';

const exec = promisify(execFile);

// The agent's service, as docs/DEPLOY.md installs it: a systemd user unit on Linux, a launchd
// agent on macOS. A restart leaves tmux and every workspace running (KillMode=process).
export function agentService(platform: NodeJS.Platform = process.platform, uid = process.getuid?.() ?? 0): AgentServicePort {
  return {
    async restart() {
      const [command, args] =
        platform === 'darwin'
          ? ['launchctl', ['kickstart', '-k', `gui/${uid}/com.perch.agent`]]
          : ['systemctl', ['--user', 'restart', 'perch-agent']];
      try {
        await exec(command, args, { env: childEnv() });
      } catch (err) {
        const stderr = (err as { stderr?: string }).stderr?.trim();
        throw new Error(`${command} ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
      }
      return `${command} ${args.join(' ')}`;
    },
  };
}
