import { describe, expect, it } from 'vitest';
import { parseEnvFile } from './agent-env';
import {
  describeStep,
  parseSetupFlags,
  planSetup,
  type ServeConfig,
  type SetupFlags,
  type SetupState,
  type SetupStep,
  type TailscaleStatus,
} from './setup-machine';

const REPO = '/home/u/workspace/perch';
const HOST = 'dev.example.ts.net';
const TEMPLATE = [
  '[Unit]',
  'Description=Tarfa agent',
  '',
  '[Service]',
  'ExecStart=/usr/bin/env bash REPO_PATH/deploy/run-agent.sh',
  'KillMode=process',
  '',
].join('\n');

// What `tailscale status --json` reports on a node with MagicDNS, HTTPS and Funnel on.
const TAILSCALE: TailscaleStatus = {
  BackendState: 'Running',
  CurrentTailnet: { MagicDNSEnabled: true },
  CertDomains: [HOST],
  Self: {
    DNSName: `${HOST}.`,
    CapMap: { funnel: null, https: null, 'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': null },
  },
};

function flags(over: Partial<SetupFlags> = {}): SetupFlags {
  return {
    machineId: 'dev',
    projectRoots: ['/home/u/workspace', '/home/u/other'],
    phonePort: 8797,
    tailscale: 'funnel',
    tailscalePort: 10000,
    slug: 'abu',
    addresses: [],
    pair: false,
    dryRun: false,
    ...over,
  };
}

function fresh(over: Partial<SetupState> = {}): SetupState {
  return {
    repo: REPO,
    service: { kind: 'systemd', template: TEMPLATE, installed: null, enabled: false },
    envText: null,
    newToken: 'generated-token',
    hasKey: false,
    roster: 'absent',
    hooksCurrent: false,
    legacyService: false,
    stateMoved: true,
    phonePortOwner: 'free',
    hooksPortOwner: 'free',
    tailscale: TAILSCALE,
    serve: {},
    ...over,
  };
}

const TARGET = 'http://127.0.0.1:8797';
const SERVED: ServeConfig = {
  TCP: { '10000': { HTTPS: true } },
  Web: { [`${HOST}:10000`]: { Handlers: { '/abu': { Proxy: TARGET } } } },
  AllowFunnel: { [`${HOST}:10000`]: true },
};

function plan(f: SetupFlags, s: SetupState): SetupStep[] {
  const result = planSetup(f, s);
  if ('error' in result) throw new Error(result.error);
  return result.steps;
}

function errorOf(f: SetupFlags, s: SetupState): string {
  const result = planSetup(f, s);
  if (!('error' in result)) throw new Error(`expected an error, got ${JSON.stringify(result.steps.map((x) => x.kind))}`);
  return result.error;
}

// The state a fresh machine is left in once the plan for it has been applied.
function applied(f: SetupFlags, s: SetupState): SetupState {
  let next = { ...s };
  for (const step of plan(f, s)) {
    if (step.kind === 'write-env') next = { ...next, envText: step.text };
    if (step.kind === 'create-key') next = { ...next, hasKey: true };
    if (step.kind === 'write-roster') next = { ...next, roster: step.mode };
    if (step.kind === 'install-unit') next = { ...next, service: { ...next.service, installed: step.text, enabled: true } };
    if (step.kind === 'install-hooks') next = { ...next, hooksCurrent: true };
    if (step.kind === 'tailscale-serve') next = { ...next, serve: SERVED };
    if (step.kind === 'restart') next = { ...next, phonePortOwner: 'ours', hooksPortOwner: 'ours' };
    if (step.kind === 'move-state') next = { ...next, stateMoved: true };
    if (step.kind === 'remove-legacy-service') next = { ...next, legacyService: false };
  }
  return next;
}

describe('planSetup', () => {
  describe('a machine set up before the rename', () => {
    const OLD_ENV = 'PERCH_TOKEN=keep-me\nPERCH_MACHINE_ID=dev\nexport PERCH_PROJECT_ROOTS=/home/u/workspace:/home/u/other\nPERCH_PHONE_PORT=8797\n# PERCH_STATS=off\n';
    const old = () =>
      fresh({
        envText: OLD_ENV,
        hasKey: true,
        roster: 'off',
        hooksCurrent: false,
        legacyService: true,
        stateMoved: false,
        service: { kind: 'systemd', template: TEMPLATE, installed: null, enabled: false },
        phonePortOwner: 'ours',
        hooksPortOwner: 'ours',
        serve: SERVED,
      });

    it('stops the old service, moves ~/.perch, then installs and starts the new one before any step that can fail, and removes the old one last', () => {
      expect(plan(flags(), old()).map((s) => s.kind)).toEqual([
        'stop-legacy-service',
        'move-state',
        'write-env',
        'install-unit',
        'restart',
        'check-listener',
        'install-hooks',
        'remove-legacy-service',
      ]);
    });

    it('renames agent.env to TARFA_ names, keeping the token and every other byte', () => {
      const env = plan(flags(), old()).find((s) => s.kind === 'write-env');
      expect(env).toMatchObject({
        text: 'TARFA_TOKEN=keep-me\nTARFA_MACHINE_ID=dev\nexport TARFA_PROJECT_ROOTS=/home/u/workspace:/home/u/other\nTARFA_PHONE_PORT=8797\n# PERCH_STATS=off\nTARFA_PHONE_ADDRESSES=wss://dev.example.ts.net:10000/abu\nTARFA_PWA_ORIGIN=https://tarfa.app\n',
      });
      expect(env && 'changes' in env ? env.changes.slice(0, 4) : []).toEqual([
        'PERCH_TOKEN renamed TARFA_TOKEN',
        'PERCH_MACHINE_ID renamed TARFA_MACHINE_ID',
        'PERCH_PROJECT_ROOTS renamed TARFA_PROJECT_ROOTS',
        'PERCH_PHONE_PORT renamed TARFA_PHONE_PORT',
      ]);
    });

    it('drops a PERCH_ line its TARFA_ twin overrides', () => {
      const env = plan(flags(), fresh({ ...old(), envText: `${OLD_ENV}TARFA_MACHINE_ID=dev\n` })).find((s) => s.kind === 'write-env');
      expect(env && 'text' in env ? env.text.match(/MACHINE_ID/g) : null).toEqual(['MACHINE_ID']);
    });

    it('plans nothing once applied', () => {
      expect(plan(flags(), applied(flags(), old()))).toEqual([]);
    });
  });

  it('sets a fresh machine up in order, the roster written before the service first starts', () => {
    const steps = plan(flags(), fresh());
    expect(steps.map((s) => s.kind)).toEqual([
      'write-env',
      'create-key',
      'write-roster',
      'install-unit',
      'install-hooks',
      'tailscale-serve',
      'restart',
      'check-listener',
    ]);
    expect(steps.find((s) => s.kind === 'write-roster')).toEqual({ kind: 'write-roster', mode: 'off' });
    expect(steps.find((s) => s.kind === 'install-unit')).toMatchObject({ text: TEMPLATE.replace('REPO_PATH', REPO) });
    expect(steps.find((s) => s.kind === 'tailscale-serve')).toEqual({ kind: 'tailscale-serve', port: 10000, path: '/abu', target: TARGET, funnel: true });
    expect(steps.find((s) => s.kind === 'check-listener')).toEqual({ kind: 'check-listener', port: 8797 });
  });

  it('writes the agent.env a fresh machine needs, with a new token and the roots colon-separated', () => {
    const env = plan(flags({ defaultPath: '/home/u/workspace' }), fresh()).find((s) => s.kind === 'write-env');
    const values = parseEnvFile(env!.kind === 'write-env' ? env!.text : '');
    expect(values).toMatchObject({
      TARFA_TOKEN: 'generated-token',
      TARFA_MACHINE_ID: 'dev',
      TARFA_PROJECT_ROOTS: '/home/u/workspace:/home/u/other',
      TARFA_DEFAULT_PATH: '/home/u/workspace',
      TARFA_PHONE_PORT: '8797',
      TARFA_PHONE_ADDRESSES: `wss://${HOST}:10000/abu`,
      TARFA_PWA_ORIGIN: 'https://tarfa.app',
    });
  });

  it('changes nothing when rerun with the same flags', () => {
    const f = flags();
    expect(plan(f, applied(f, fresh()))).toEqual([]);
  });

  it('only pairs when rerun with --pair', () => {
    const f = flags({ pair: true });
    expect(plan(f, applied(f, fresh())).map((s) => s.kind)).toEqual(['pair']);
  });

  it('keeps an existing token, other lines and an existing PWA origin', () => {
    const envText = 'TARFA_TOKEN=old\n# a comment\nTARFA_MACHINE_ID=dev\nTARFA_PWA_ORIGIN=https://staging.example:8443\nOTHER=1\n';
    const env = plan(flags(), fresh({ envText })).find((s) => s.kind === 'write-env');
    const text = env!.kind === 'write-env' ? env!.text : '';
    expect(text).toContain('# a comment\n');
    expect(parseEnvFile(text)).toMatchObject({ TARFA_TOKEN: 'old', OTHER: '1', TARFA_PWA_ORIGIN: 'https://staging.example:8443' });
  });

  it('writes the PWA origin when --pwa names one', () => {
    const envText = 'TARFA_TOKEN=old\nTARFA_PWA_ORIGIN=https://staging.example:8443\n';
    const env = plan(flags({ pwa: 'https://self.example' }), fresh({ envText })).find((s) => s.kind === 'write-env');
    expect(parseEnvFile(env!.kind === 'write-env' ? env!.text : '').TARFA_PWA_ORIGIN).toBe('https://self.example');
  });

  it('never replaces the agent key or an existing roster', () => {
    const kinds = plan(flags(), fresh({ hasKey: true, roster: 'closed' })).map((s) => s.kind);
    expect(kinds).not.toContain('create-key');
    expect(kinds).not.toContain('write-roster');
  });

  it('changes an existing roster only when --token-enrolment asks', () => {
    expect(plan(flags({ tokenEnrolment: 'on' }), fresh({ roster: 'off' }))).toContainEqual({ kind: 'write-roster', mode: 'on' });
    expect(plan(flags({ tokenEnrolment: 'off' }), fresh({ roster: 'off' })).map((s) => s.kind)).not.toContain('write-roster');
    expect(plan(flags({ tokenEnrolment: 'on' }), fresh())).toContainEqual({ kind: 'write-roster', mode: 'on' });
  });

  it('leaves an installed unit alone when it runs the checkout through run-agent.sh with KillMode=process', () => {
    const installed = [
      '[Service]',
      `WorkingDirectory=${REPO}`,
      'ExecStart=/home/u/.local/bin/mise exec -- bash deploy/run-agent.sh',
      'KillMode=process',
      '',
    ].join('\n');
    const kinds = plan(flags(), fresh({ service: { kind: 'systemd', template: TEMPLATE, installed, enabled: true } })).map((s) => s.kind);
    expect(kinds).not.toContain('install-unit');
  });

  it('reinstalls a current unit that is not enabled at boot', async () => {
    const installed = TEMPLATE.replace('REPO_PATH', REPO);
    expect(plan(flags(), fresh({ service: { kind: 'systemd', template: TEMPLATE, installed, enabled: false } })).map((s) => s.kind)).toContain('install-unit');
  });

  it('rewrites an installed unit without KillMode=process or pointing at another checkout', () => {
    const noKill = `[Service]\nExecStart=/usr/bin/env bash ${REPO}/deploy/run-agent.sh\n`;
    const elsewhere = '[Service]\nExecStart=/usr/bin/env bash /elsewhere/deploy/run-agent.sh\nKillMode=process\n';
    for (const installed of [noKill, elsewhere]) {
      expect(plan(flags(), fresh({ service: { kind: 'systemd', template: TEMPLATE, installed, enabled: true } })).map((s) => s.kind)).toContain('install-unit');
    }
  });

  it('treats a launchd plist that runs the checkout as current', () => {
    const template = '<plist><string>REPO_PATH/deploy/run-agent.sh</string></plist>\n';
    const installed = `<plist><string>${REPO}/deploy/run-agent.sh</string></plist>\n`;
    expect(plan(flags(), fresh({ service: { kind: 'launchd', template, installed, enabled: true } })).map((s) => s.kind)).not.toContain('install-unit');
    expect(plan(flags(), fresh({ service: { kind: 'launchd', template, installed: null, enabled: false } }))).toContainEqual({
      kind: 'install-unit',
      text: installed,
    });
  });

  it('puts the derived address first, then --address values', () => {
    const env = plan(flags({ addresses: ['wss://proxy.example/abu'] }), fresh()).find((s) => s.kind === 'write-env');
    expect(parseEnvFile(env!.kind === 'write-env' ? env!.text : '').TARFA_PHONE_ADDRESSES).toBe(
      `wss://${HOST}:10000/abu,wss://proxy.example/abu`,
    );
  });

  it('defaults to port 443 for serve and 10000 for Funnel, and to path / without a slug', () => {
    const serve = plan(flags({ tailscale: 'serve', tailscalePort: undefined, slug: undefined }), fresh());
    expect(serve.find((s) => s.kind === 'tailscale-serve')).toEqual({ kind: 'tailscale-serve', port: 443, path: '/', target: TARGET, funnel: false });
    const funnel = plan(flags({ tailscalePort: undefined }), fresh());
    expect(funnel.find((s) => s.kind === 'tailscale-serve')).toMatchObject({ port: 10000 });
  });

  it('refuses more than four addresses', () => {
    const addresses = ['wss://a.example', 'wss://b.example', 'wss://c.example', 'wss://d.example'];
    expect(errorOf(flags({ addresses }), fresh())).toMatch(/at most 4/);
  });

  it('refuses a phone port another process holds, naming the fix', () => {
    expect(errorOf(flags(), fresh({ phonePortOwner: 'other' }))).toMatch(/8797.*--phone-port/);
    expect(plan(flags(), fresh({ phonePortOwner: 'ours' })).length).toBeGreaterThan(0);
  });

  it('refuses a hooks port another process holds on a machine without TARFA_PORT', () => {
    expect(errorOf(flags(), fresh({ hooksPortOwner: 'other' }))).toMatch(/TARFA_PORT/);
  });

  it('prints the operator line for a second user with --tailscale none and a slug', () => {
    const steps = plan(flags({ tailscale: 'none', tailscalePort: 443, addresses: [`wss://${HOST}/bob`], slug: 'bob', phonePort: 8798 }), fresh({ tailscale: null }));
    expect(steps.map((s) => s.kind)).not.toContain('tailscale-serve');
    expect(steps).toContainEqual({
      kind: 'print',
      line: 'tailscale serve --bg --https=443 --set-path=/bob http://127.0.0.1:8798',
    });
  });

  it('takes the operator line\'s port from --tailscale-port, else the address under the slug, else 443', () => {
    const line = (f: Partial<SetupFlags>, s: Partial<SetupState> = {}) =>
      plan(flags({ tailscale: 'none', tailscalePort: undefined, slug: 'bob', phonePort: 8798, ...f }), fresh({ tailscale: null, serve: null, ...s })).find((x) => x.kind === 'print');
    expect(line({ addresses: [`wss://${HOST}:10000/bob`] })).toEqual({ kind: 'print', line: 'tailscale serve --bg --https=10000 --set-path=/bob http://127.0.0.1:8798' });
    expect(line({ addresses: [`wss://${HOST}:10000/bob`], tailscalePort: 8443 })).toMatchObject({ line: expect.stringContaining('--https=8443 ') });
    expect(line({ addresses: [`wss://${HOST}:10000/other`, `wss://${HOST}:8443/bob`] })).toMatchObject({ line: expect.stringContaining('--https=8443 ') });
    expect(line({ addresses: [`wss://${HOST}:10000/other`] })).toMatchObject({ line: expect.stringContaining('--https=443 ') });
  });

  it('prints the funnel form when the serve config shows that port on Funnel', () => {
    const steps = plan(
      flags({ tailscale: 'none', tailscalePort: undefined, slug: 'bob', phonePort: 8798, addresses: [`wss://${HOST}:10000/bob`] }),
      fresh({ tailscale: null, serve: SERVED }),
    );
    expect(steps).toContainEqual({ kind: 'print', line: 'tailscale funnel --bg --https=10000 --set-path=/bob http://127.0.0.1:8798' });
  });

  it('refuses to publish an address while token enrolment is on, unless asked to keep it', () => {
    const f = flags({ tailscale: 'none', slug: 'bob', phonePort: 8798, addresses: [`wss://${HOST}:10000/bob`] });
    expect(errorOf(f, fresh({ tailscale: null, roster: 'on' }))).toMatch(/--token-enrolment off.*--token-enrolment on/s);
    expect(errorOf(flags(), fresh({ roster: 'on' }))).toMatch(/--token-enrolment off/);
    expect(plan({ ...f, tokenEnrolment: 'off' }, fresh({ tailscale: null, roster: 'on' }))).toContainEqual({ kind: 'write-roster', mode: 'off' });
    expect(plan({ ...f, tokenEnrolment: 'on' }, fresh({ tailscale: null, roster: 'on' })).map((s) => s.kind)).not.toContain('write-roster');
    expect(plan(flags({ tailscale: 'none', slug: undefined }), fresh({ tailscale: null, roster: 'on' })).map((s) => s.kind)).not.toContain('write-roster');
    expect(plan(f, fresh({ tailscale: null }))).toContainEqual({ kind: 'write-roster', mode: 'off' });
    const envText = `TARFA_TOKEN=t\nTARFA_PHONE_ADDRESSES=wss://${HOST}/bob\n`;
    expect(errorOf(flags({ tailscale: 'none', slug: undefined }), fresh({ tailscale: null, roster: 'on', envText }))).toMatch(/--token-enrolment off/);
  });

  describe('Tailscale checks', () => {
    const cases: Array<[string, Partial<TailscaleStatus> | null, RegExp]> = [
      ['not installed or not running', null, /tailscale up/],
      ['logged out', { BackendState: 'NeedsLogin' }, /logged out|NeedsLogin/],
      ['MagicDNS off', { CurrentTailnet: { MagicDNSEnabled: false } }, /MagicDNS.*admin console/],
      ['HTTPS certificates off', { CertDomains: [] }, /HTTPS.*admin console/],
    ];
    for (const [name, change, message] of cases) {
      it(`refuses when ${name}, changing nothing`, () => {
        const tailscale = change === null ? null : { ...TAILSCALE, ...change };
        expect(errorOf(flags(), fresh({ tailscale }))).toMatch(message);
      });
    }

    it('refuses Funnel on a node the policy does not allow it', () => {
      const tailscale = { ...TAILSCALE, Self: { ...TAILSCALE.Self, CapMap: { https: null } } };
      expect(errorOf(flags(), fresh({ tailscale }))).toMatch(/funnel.*policy file/i);
    });

    it('refuses a Funnel port outside 443, 8443 and 10000', () => {
      expect(errorOf(flags({ tailscalePort: 8444 }), fresh())).toMatch(/443, 8443 or 10000/);
    });

    it('refuses a Funnel port the node attribute does not list', () => {
      const tailscale = { ...TAILSCALE, Self: { ...TAILSCALE.Self, CapMap: { funnel: null, 'https://tailscale.com/cap/funnel-ports?ports=443': null } } };
      expect(errorOf(flags(), fresh({ tailscale }))).toMatch(/10000.*funnel-ports|not allowed on port 10000/);
    });

    it('refuses to replace a serve entry on the same port and path that points elsewhere', () => {
      const serve: ServeConfig = { Web: { [`${HOST}:10000`]: { Handlers: { '/abu': { Proxy: 'http://127.0.0.1:9999' } } } } };
      expect(errorOf(flags(), fresh({ serve }))).toMatch(/already.*127\.0\.0\.1:9999/);
    });

    it('refuses a port that forwards raw TCP', () => {
      const serve: ServeConfig = { TCP: { '10000': { TCPForward: '127.0.0.1:22' } } };
      expect(errorOf(flags(), fresh({ serve }))).toMatch(/10000/);
    });

    it('serves beside another agent on the same port under another slug', () => {
      const serve: ServeConfig = { TCP: { '10000': { HTTPS: true } }, Web: { [`${HOST}:10000`]: { Handlers: { '/bob': { Proxy: 'http://127.0.0.1:8798' } } } } };
      expect(plan(flags({ tailscale: 'serve' }), fresh({ serve })).map((s) => s.kind)).toContain('tailscale-serve');
    });

    it('refuses to read no serve config as an empty one', () => {
      expect(errorOf(flags(), fresh({ serve: null }))).toMatch(/serve status/);
    });

    it('refuses Funnel on a port whose other handlers are tailnet-only', () => {
      const serve: ServeConfig = { TCP: { '10000': { HTTPS: true } }, Web: { [`${HOST}:10000`]: { Handlers: { '/bob': { Proxy: 'http://127.0.0.1:8798' } } } } };
      expect(errorOf(flags(), fresh({ serve }))).toMatch(/also publish https:\/\/dev\.example\.ts\.net:10000\/bob/);
    });

    it('joins a port already on Funnel beside another agent', () => {
      const serve: ServeConfig = { ...SERVED, Web: { [`${HOST}:10000`]: { Handlers: { '/bob': { Proxy: 'http://127.0.0.1:8798' } } } } };
      expect(plan(flags(), fresh({ serve })).find((s) => s.kind === 'tailscale-serve')).toMatchObject({ funnel: true });
    });

    it('keeps Funnel on when --tailscale serve adds a slug to a port already on Funnel', () => {
      const serve: ServeConfig = { ...SERVED, Web: { [`${HOST}:10000`]: { Handlers: { '/bob': { Proxy: 'http://127.0.0.1:8798' } } } } };
      expect(plan(flags({ tailscale: 'serve' }), fresh({ serve })).find((s) => s.kind === 'tailscale-serve')).toEqual({
        kind: 'tailscale-serve',
        port: 10000,
        path: '/abu',
        target: TARGET,
        funnel: true,
      });
    });

    it('says a serve address on a port already on Funnel is public', () => {
      const result = planSetup(flags({ tailscale: 'serve' }), fresh({ serve: SERVED }));
      expect(result).toMatchObject({ checks: expect.arrayContaining([expect.stringMatching(/internet/)]) });
    });

    it('warns when a public port would be published with token enrolment on', () => {
      const result = planSetup(flags({ tokenEnrolment: 'on' }), fresh({ roster: 'on' }));
      expect(result).toMatchObject({ checks: expect.arrayContaining([expect.stringMatching(/tarfa devices enrolment off/)]) });
      expect(planSetup(flags(), fresh({ roster: 'off' }))).not.toMatchObject({ checks: expect.arrayContaining([expect.stringMatching(/warning/)]) });
    });

    it('turns Funnel on for an entry already served on the tailnet only', () => {
      const serve: ServeConfig = { ...SERVED, AllowFunnel: {} };
      expect(plan(flags(), fresh({ serve })).find((s) => s.kind === 'tailscale-serve')).toMatchObject({ funnel: true });
    });
  });
});

describe('parseSetupFlags', () => {
  const base = ['--machine-id', 'dev', '--project-roots', '/home/u/workspace,/home/u/other'];

  it('reads every flag', () => {
    expect(
      parseSetupFlags([
        ...base,
        '--default-path', '/home/u/workspace',
        '--phone-port', '8798',
        '--slug', 'bob',
        '--tailscale', 'none',
        '--tailscale-port', '443',
        '--address', 'wss://a.example/bob',
        '--address', 'wss://b.example:8443/bob',
        '--pwa', 'https://self.example/',
        '--pair',
        '--dry-run',
        '--token-enrolment', 'on',
      ]),
    ).toEqual({
      machineId: 'dev',
      projectRoots: ['/home/u/workspace', '/home/u/other'],
      defaultPath: '/home/u/workspace',
      phonePort: 8798,
      slug: 'bob',
      tailscale: 'none',
      tailscalePort: 443,
      addresses: ['wss://a.example/bob', 'wss://b.example:8443/bob'],
      pwa: 'https://self.example',
      pair: true,
      dryRun: true,
      tokenEnrolment: 'on',
    });
  });

  it('defaults the phone port to 8797 and Tailscale to none', () => {
    expect(parseSetupFlags(base)).toMatchObject({ phonePort: 8797, tailscale: 'none', addresses: [], pair: false, dryRun: false });
  });

  const invalid: Array<[string, string[]]> = [
    ['no machine id', ['--project-roots', '/a']],
    ['no project roots', ['--machine-id', 'dev']],
    ['a relative root', ['--machine-id', 'dev', '--project-roots', 'a']],
    ['an unknown flag', [...base, '--bogus', 'x']],
    ['a stray argument', [...base, 'extra']],
    ['a bad slug', [...base, '--slug', 'a/b']],
    ['a slug too long', [...base, '--slug', 'a'.repeat(65)]],
    ['a bad phone port', [...base, '--phone-port', '0']],
    ['a bad Tailscale port', [...base, '--tailscale-port', 'x']],
    ['a bad Tailscale mode', [...base, '--tailscale', 'up']],
    ['a ws address off loopback', [...base, '--address', 'ws://a.example/x']],
    ['an address with a deep path', [...base, '--address', 'wss://a.example/x/y']],
    ['a bad PWA origin', [...base, '--pwa', 'ftp://x']],
    ['a relative default path', [...base, '--default-path', 'x']],
    ['a root bash would split', ['--machine-id', 'dev', '--project-roots', '/home/u/My Projects']],
    ['a root bash would expand', ['--machine-id', 'dev', '--project-roots', '/home/$USER']],
    ['a default path bash would run', [...base, '--default-path', '/home/u/`id`']],
    ['a bad token enrolment', [...base, '--token-enrolment', 'closed']],
    ['a flag missing its value', [...base, '--slug']],
  ];
  for (const [name, argv] of invalid) {
    it(`refuses ${name}`, () => {
      expect(parseSetupFlags(argv)).toHaveProperty('error');
    });
  }
});

describe('describeStep', () => {
  it('never shows a generated token', () => {
    const env = plan(flags(), fresh()).find((s) => s.kind === 'write-env')!;
    expect(describeStep(env, '/repo/deploy/agent.env')).not.toContain('generated-token');
  });
});
