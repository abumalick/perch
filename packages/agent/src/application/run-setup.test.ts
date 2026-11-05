import { describe, expect, it } from 'vitest';
import { TailscaleOperatorError } from '../ports/tailscale-port';
import { runSetup, type SetupEffects } from './run-setup';
import type { SetupStep } from './setup-machine';

const ALL: SetupStep[] = [
  { kind: 'write-env', text: 'PERCH_TOKEN=x\n', changes: ['PERCH_TOKEN=(generated)'] },
  { kind: 'create-key' },
  { kind: 'write-roster', mode: 'off' },
  { kind: 'install-unit', text: '[Service]\n' },
  { kind: 'install-hooks' },
  { kind: 'tailscale-serve', port: 10000, path: '/abu', target: 'http://127.0.0.1:8797', funnel: true },
  { kind: 'restart' },
  { kind: 'check-listener', port: 8797 },
  { kind: 'print', line: 'tailscale serve --bg --https=443 --set-path=/bob http://127.0.0.1:8798' },
  { kind: 'pair' },
];

function fakes(fail?: { at: string; error?: Error }) {
  const calls: string[] = [];
  const act = (name: string, result?: unknown) => async () => {
    calls.push(name);
    if (fail?.at === name) throw fail.error ?? new Error(`${name} broke`);
    return result;
  };
  const effects: SetupEffects = {
    envPath: '/repo/deploy/agent.env',
    writeEnv: act('write-env', '/repo/deploy/agent.env.bak-1') as SetupEffects['writeEnv'],
    createKey: act('create-key') as SetupEffects['createKey'],
    writeRoster: act('write-roster') as SetupEffects['writeRoster'],
    installUnit: act('install-unit', ['systemctl --user enable perch-agent']) as SetupEffects['installUnit'],
    installHooks: act('install-hooks') as SetupEffects['installHooks'],
    serve: act('tailscale-serve') as SetupEffects['serve'],
    restart: act('restart', 'systemctl --user restart perch-agent') as SetupEffects['restart'],
    checkListener: (async () => {
      calls.push('check-listener');
      return fail?.at !== 'check-listener';
    }) as SetupEffects['checkListener'],
    pair: act('pair', 'the link') as SetupEffects['pair'],
  };
  return { effects, calls };
}

describe('runSetup', () => {
  it('applies every step in order', async () => {
    const { effects, calls } = fakes();
    const result = await runSetup({ steps: ALL, checks: ['tailscale: ok'] }, effects, { dryRun: false, phonePort: 8797 });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['write-env', 'create-key', 'write-roster', 'install-unit', 'install-hooks', 'tailscale-serve', 'restart', 'check-listener', 'pair']);
    expect(result.lines.join('\n')).toContain('tailscale serve --bg --https=443 --set-path=/bob http://127.0.0.1:8798');
    expect(result.lines.at(-1)).toBe('the link');
  });

  it('writes the roster before the unit is installed', async () => {
    const { effects, calls } = fakes();
    await runSetup({ steps: ALL, checks: [] }, effects, { dryRun: false, phonePort: 8797 });
    expect(calls.indexOf('write-roster')).toBeLessThan(calls.indexOf('install-unit'));
  });

  it('stops at the first failure, with its message', async () => {
    const { effects, calls } = fakes({ at: 'install-unit' });
    const result = await runSetup({ steps: ALL, checks: [] }, effects, { dryRun: false, phonePort: 8797 });
    expect(result.ok).toBe(false);
    expect(calls).toEqual(['write-env', 'create-key', 'write-roster', 'install-unit']);
    expect(result.lines.at(-1)).toMatch(/install-unit broke/);
  });

  it('turns a Tailscale permission refusal into the operator line', async () => {
    const { effects } = fakes({ at: 'tailscale-serve', error: new TailscaleOperatorError('Access denied') });
    const result = await runSetup({ steps: ALL, checks: [] }, effects, { dryRun: false, phonePort: 8797 });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('sudo tailscale set --operator=$USER');
  });

  it('fails when the phone port does not answer after the restart', async () => {
    const { effects } = fakes({ at: 'check-listener' });
    const result = await runSetup({ steps: ALL, checks: [] }, effects, { dryRun: false, phonePort: 8797 });
    expect(result.ok).toBe(false);
    expect(result.lines.at(-1)).toMatch(/8797/);
  });

  it('applies nothing on a dry run, and prints the plan and the checks', async () => {
    const { effects, calls } = fakes();
    const result = await runSetup({ steps: ALL, checks: ['tailscale: running'] }, effects, { dryRun: true, phonePort: 8797 });
    expect(calls).toEqual([]);
    expect(result.ok).toBe(true);
    const text = result.lines.join('\n');
    expect(text).toContain('tailscale: running');
    expect(text).toContain('tailscale funnel --bg --https=10000 --set-path=/abu http://127.0.0.1:8797');
    expect(text).toMatch(/dry run/);
  });

  it('only checks the phone port when there is nothing to do', async () => {
    const { effects, calls } = fakes();
    const result = await runSetup({ steps: [], checks: [] }, effects, { dryRun: false, phonePort: 8797 });
    expect(calls).toEqual(['check-listener']);
    expect(result.lines.join('\n')).toMatch(/already set up/);
  });

  it('fails a rerun that changes nothing when the phone port does not answer', async () => {
    const { effects } = fakes({ at: 'check-listener' });
    const result = await runSetup({ steps: [], checks: [] }, effects, { dryRun: false, phonePort: 8797 });
    expect(result.ok).toBe(false);
    expect(result.lines.at(-1)).toMatch(/8797/);
  });
});
