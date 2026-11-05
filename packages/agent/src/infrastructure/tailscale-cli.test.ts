import { describe, expect, it } from 'vitest';
import { planSetup } from '../application/setup-machine';
import { TailscaleOperatorError } from '../ports/tailscale-port';
import { tailscaleCli, type Exec } from './tailscale-cli';

// `tailscale status --json` and `tailscale serve status --json` from a real node (1.102), trimmed
// to the fields setup reads, with the host renamed.
const STATUS = JSON.stringify({
  Version: '1.102.2',
  BackendState: 'Running',
  CurrentTailnet: { Name: 'someone@example.com', MagicDNSSuffix: 'example.ts.net', MagicDNSEnabled: true },
  CertDomains: ['dev.example.ts.net'],
  Self: {
    DNSName: 'dev.example.ts.net.',
    CapMap: {
      'default-auto-update': [true],
      funnel: null,
      https: null,
      'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': null,
      'https://tailscale.com/cap/is-admin': null,
    },
  },
});
const SERVE = JSON.stringify({
  TCP: { '8443': { HTTPS: true }, '8451': { HTTPS: true } },
  Web: {
    'dev.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4173' } } },
    'dev.example.ts.net:8451': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8450' } } },
  },
});

function fake(answers: Record<string, { stdout?: string; error?: { stderr: string } }>) {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    const answer = answers[args.join(' ')] ?? answers['*'];
    if (!answer) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    if (answer.error) throw Object.assign(new Error('failed'), answer.error);
    return { stdout: answer.stdout ?? '' };
  };
  return { cli: tailscaleCli(exec), calls };
}

describe('tailscaleCli', () => {
  it('reads the status and serve config a real node reports', async () => {
    const { cli } = fake({ 'status --json': { stdout: STATUS }, 'serve status --json': { stdout: SERVE } });
    const status = await cli.status();
    const serve = await cli.serveStatus();
    expect(serve?.Web?.['dev.example.ts.net:8443']?.Handlers?.['/']?.Proxy).toBe('http://127.0.0.1:4173');
    const plan = planSetup(
      { machineId: 'dev', projectRoots: ['/w'], phonePort: 8797, tailscale: 'funnel', tailscalePort: 10000, slug: 'abu', addresses: [], pair: false, dryRun: false },
      {
        repo: '/r',
        service: { kind: 'systemd', template: '', installed: null, enabled: false },
        envText: null,
        newToken: 't',
        hasKey: true,
        roster: 'off',
        hooksCurrent: true,
        legacyService: false,
        stateMoved: true,
        phonePortOwner: 'free',
        hooksPortOwner: 'free',
        tailscale: status,
        serve,
      },
    );
    expect(plan).toMatchObject({ checks: expect.arrayContaining(['tailscale: Funnel allowed on port 10000']) });
  });

  it('reads an empty serve config as none', async () => {
    const { cli } = fake({ 'serve status --json': { stdout: '' } });
    expect(await cli.serveStatus()).toEqual({});
  });

  it('reports no status when tailscale is missing or its daemon does not answer', async () => {
    expect(await fake({}).cli.status()).toBeNull();
    expect(await fake({ 'status --json': { error: { stderr: 'failed to connect to local tailscaled' } } }).cli.status()).toBeNull();
  });

  it('serves a slug, and publishes it with funnel when asked', async () => {
    const { cli, calls } = fake({ '*': { stdout: '' } });
    await cli.serve({ port: 443, path: '/bob', target: 'http://127.0.0.1:8798', funnel: false });
    await cli.serve({ port: 10000, path: '/', target: 'http://127.0.0.1:8797', funnel: true });
    expect(calls).toEqual([
      ['serve', '--bg', '--https=443', '--set-path=/bob', 'http://127.0.0.1:8798'],
      ['funnel', '--bg', '--https=10000', 'http://127.0.0.1:8797'],
    ]);
  });

  it('turns a refusal for want of an operator into TailscaleOperatorError', async () => {
    for (const stderr of [
      'Access denied: serve config denied',
      "Use 'sudo tailscale serve --bg 3000' or 'sudo tailscale set --operator=$USER'",
    ]) {
      const { cli } = fake({ '*': { error: { stderr } } });
      await expect(cli.serve({ port: 443, path: '/', target: 'http://127.0.0.1:1', funnel: false })).rejects.toBeInstanceOf(TailscaleOperatorError);
    }
  });

  it('passes any other failure on with its message', async () => {
    const { cli } = fake({ '*': { error: { stderr: 'invalid port' } } });
    await expect(cli.serve({ port: 443, path: '/', target: 'http://127.0.0.1:1', funnel: false })).rejects.toThrow(/invalid port/);
  });
});
