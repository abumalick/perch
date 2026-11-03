import { describe, expect, it } from 'vitest';
import { codexVersions } from './codex-versions';

const DAEMON = JSON.stringify({ status: 'running', cliVersion: '0.163.0', appServerVersion: '0.166.0' });

function shell(outputs: Record<string, string | Error>) {
  const scripts: string[] = [];
  const run = async (script: string) => {
    scripts.push(script);
    const out = outputs[script];
    if (out instanceof Error) throw out;
    return out ?? '';
  };
  return { run, scripts };
}

describe('codexVersions', () => {
  it('reads the CLI from codex --version and the daemon from its appServerVersion', async () => {
    const { run, scripts } = shell({ 'codex --version': 'codex-cli 0.163.0\n', 'codex app-server daemon version': DAEMON });
    expect(await codexVersions(run)()).toEqual({ cli: '0.163.0', appServer: '0.166.0' });
    expect(scripts.sort()).toEqual(['codex --version', 'codex app-server daemon version']);
  });

  it('says the app server is not running when the daemon names no version', async () => {
    const { run } = shell({ 'codex --version': 'codex-cli 0.166.0', 'codex app-server daemon version': '{"status":"stopped"}' });
    await expect(codexVersions(run)()).rejects.toThrow('the Codex app server is not running');
  });

  it('says codex is missing when the CLI cannot be run', async () => {
    const { run } = shell({ 'codex --version': new Error('exit 127'), 'codex app-server daemon version': DAEMON });
    await expect(codexVersions(run)()).rejects.toThrow(/cannot run codex --version/);
  });
});
