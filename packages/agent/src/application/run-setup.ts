// Applies a `perch setup` plan in order, stopping at the first failure. A dry run applies nothing.
import { TailscaleOperatorError } from '../ports/tailscale-port';
import type { EnrolmentMode } from './device-roster';
import { describeStep, type SetupStep } from './setup-machine';

export interface SetupEffects {
  envPath: string;
  // Returns the backup's path, or null when there was no file to back up.
  writeEnv(text: string): Promise<string | null>;
  createKey(): Promise<void>;
  writeRoster(mode: EnrolmentMode): Promise<void>;
  installUnit(text: string): Promise<string[]>;
  installHooks(): Promise<void>;
  serve(entry: { port: number; path: string; target: string; funnel: boolean }): Promise<void>;
  restart(): Promise<string>;
  // Whether the phone port answers a WebSocket upgrade.
  checkListener(port: number): Promise<boolean>;
  pair(): Promise<string>;
}

const OPERATOR = [
  'Tailscale needs root or an operator to change its serve config. Run once:',
  '  sudo tailscale set --operator=$USER',
  'then run perch setup again.',
].join('\n');

export async function runSetup(
  plan: { steps: SetupStep[]; checks: string[] },
  effects: SetupEffects,
  options: { dryRun: boolean; phonePort: number },
): Promise<{ ok: boolean; lines: string[] }> {
  const lines = [...plan.checks];
  if (options.dryRun) {
    lines.push(plan.steps.length === 0 ? 'dry run: nothing to change' : 'dry run: perch setup would');
    for (const step of plan.steps) lines.push(`  - ${describeStep(step, effects.envPath)}`);
    return { ok: true, lines };
  }
  if (plan.steps.length === 0) {
    // A run that wrote everything and then found the agent not listening plans nothing next time,
    // so the check runs on its own too.
    if (!(await effects.checkListener(options.phonePort))) {
      lines.push(`nothing changed, but nothing answers a WebSocket upgrade on 127.0.0.1:${options.phonePort}: read the agent's log (journalctl --user -u perch-agent)`);
      return { ok: false, lines };
    }
    lines.push('this machine is already set up as asked; nothing changed, and the phone port answers');
    return { ok: true, lines };
  }
  for (const step of plan.steps) {
    try {
      const done = await apply(step, effects);
      if (done) lines.push(done);
    } catch (err) {
      lines.push(err instanceof TailscaleOperatorError ? OPERATOR : `failed: ${describeStep(step, effects.envPath)}: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, lines };
    }
  }
  return { ok: true, lines };
}

async function apply(step: SetupStep, effects: SetupEffects): Promise<string | null> {
  switch (step.kind) {
    case 'write-env': {
      const backup = await effects.writeEnv(step.text);
      return `updated ${effects.envPath}${backup ? ` (previous version kept at ${backup})` : ''}: ${step.changes.join(', ')}`;
    }
    case 'create-key':
      await effects.createKey();
      return describeStep(step, '').replace(/^create/, 'created');
    case 'write-roster':
      await effects.writeRoster(step.mode);
      return describeStep(step, '').replace(/^write/, 'wrote');
    case 'install-unit':
      return `installed the agent service: ${(await effects.installUnit(step.text)).join('; ')}`;
    case 'install-hooks':
      await effects.installHooks();
      return 'installed the hooks';
    case 'tailscale-serve':
      await effects.serve(step);
      return `ran ${describeStep(step, '')}`;
    case 'restart':
      return `restarted the agent (${await effects.restart()})`;
    case 'check-listener':
      if (!(await effects.checkListener(step.port))) {
        throw new Error(`nothing answered a WebSocket upgrade on 127.0.0.1:${step.port}: read the agent's log (journalctl --user -u perch-agent)`);
      }
      return `the phone port answers on 127.0.0.1:${step.port}`;
    case 'pair':
      return effects.pair();
    case 'print':
      return describeStep(step, '');
  }
}
