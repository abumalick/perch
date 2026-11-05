import { describe, it, expect } from 'vitest';
import { loadConfig, assertServerConfig, configWarnings } from './config';

const base = { TARFA_MACHINE_ID: 'mini', TARFA_TOKEN: 'secret' };
const reachable = { ...base, TARFA_PHONE_ADDRESSES: 'wss://a.example.ts.net' };

describe('loadConfig', () => {
  it('takes TARFA_PWA_ORIGIN over the tarfa.app default', () => {
    expect(loadConfig({ ...base, TARFA_PWA_ORIGIN: 'https://self.example' }, '/home/u').pwaOrigin).toBe('https://self.example');
  });

  it('applies defaults from the home directory', () => {
    const cfg = loadConfig(base, '/home/u');
    expect(cfg).toEqual({
      stateDir: '/home/u/.tarfa',
      machineId: 'mini',
      token: 'secret',
      port: 8787,
      projectRoots: ['/home/u/workspace'],
      pwaOrigin: 'https://tarfa.app',
      recentStorePath: '/home/u/.tarfa/recent.json',
      statusStorePath: '/home/u/.tarfa/status.json',
      hiddenFoldersPath: '/home/u/.tarfa/hidden-folders.json',
      launchersPath: '/home/u/.tarfa/launchers.json',
      keytermsPath: '/home/u/.tarfa/keyterms.txt',
      clientLogPath: '/home/u/.tarfa/client-log.jsonl',
      hookEventLogPath: '/home/u/.tarfa/hook-events.jsonl',
      messageLogPath: '/home/u/.tarfa/messages.jsonl',
      workspaceLogPath: '/home/u/.tarfa/workspace-log.jsonl',
      parkedStorePath: '/home/u/.tarfa/parked.json',
      liveSnapshotPath: '/home/u/.tarfa/live.json',
      agentKeyPath: '/home/u/.tarfa/agent-key.json',
      devicesPath: '/home/u/.tarfa/devices.json',
      pairingPath: '/home/u/.tarfa/pairing.json',
      claudeSessionsDir: '/home/u/.claude/sessions',
      inboxDir: '/home/u/.tarfa/inbox',
      sessionPrefix: 'perch-',
      phonePort: 8797,
      phoneAddresses: [],
    });
  });

  it('reads the phone port and the addresses phones reach it by', () => {
    const cfg = loadConfig({ ...base, TARFA_PHONE_PORT: '9100', TARFA_PHONE_ADDRESSES: ' wss://a.example.ts.net/x , ,wss://b.example.com ' }, '/home/u');
    expect(cfg.phonePort).toBe(9100);
    expect(cfg.phoneAddresses).toEqual(['wss://a.example.ts.net/x', 'wss://b.example.com']);
  });

  it('throws when TARFA_PHONE_PORT is not a port number', () => {
    for (const bad of ['abc', '8797.5', '0', '65536', '-1', '80x']) {
      expect(() => loadConfig({ ...base, TARFA_PHONE_PORT: bad }, '/home/u')).toThrow(/TARFA_PHONE_PORT/);
    }
  });

  it('sends the machine load unless TARFA_STATS turns it off', () => {
    expect(loadConfig(base, '/home/u').stats).toBeUndefined();
    for (const off of ['off', '0', 'false', ' OFF ']) {
      expect(loadConfig({ ...base, TARFA_STATS: off }, '/home/u').stats).toBe(false);
    }
    expect(loadConfig({ ...base, TARFA_STATS: 'on' }, '/home/u').stats).toBeUndefined();
  });

  it('plays Claude voice into the loopback subdevice TARFA_VOICE_DEVICE names', () => {
    expect(loadConfig(base, '/home/u').voiceDevice).toBeUndefined();
    expect(loadConfig({ ...base, TARFA_VOICE_DEVICE: ' ' }, '/home/u').voiceDevice).toBeUndefined();
    expect(loadConfig({ ...base, TARFA_VOICE_DEVICE: ' plughw:Loopback,0,1 ' }, '/home/u').voiceDevice).toBe('plughw:Loopback,0,1');
  });

  it('starts with relays still listed, and says once that they are gone', () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ TARFA_RELAY_URLS: 'wss://relay.example.com, ws://127.0.0.1:8450' }, 'TARFA_RELAY_URLS'],
      [{ TARFA_RELAY_URL: 'wss://relay.example.com' }, 'TARFA_RELAY_URL'],
      [{ TARFA_RELAY_URLS: 'wss://relay.example.com', TARFA_RELAY_URL: 'wss://old.example.com' }, 'TARFA_RELAY_URLS and TARFA_RELAY_URL'],
    ];
    for (const [relays, named] of cases) {
      const env = { ...reachable, ...relays };
      expect('relayUrls' in loadConfig(env, '/home/u')).toBe(false);
      expect(configWarnings(env)).toEqual([`relays are gone; remove ${named} from deploy/agent.env`]);
    }
    expect(configWarnings({ ...reachable, TARFA_RELAY_URLS: ' ' })).toEqual([]);
  });

  it('warns that phones reach an agent with no phone address only once its phone port is published', () => {
    expect(configWarnings(base)).toEqual([
      'no TARFA_PHONE_ADDRESSES: phones reach this agent only once its phone port is published (tailscale serve, a reverse proxy)',
    ]);
    expect(configWarnings({ ...base, TARFA_PHONE_ADDRESSES: 'wss://a.example.ts.net' })).toEqual([]);
  });

  it('warns that a non-loopback TARFA_HOST is ignored', () => {
    expect(configWarnings({ ...reachable, TARFA_HOST: '127.0.0.1' })).toEqual([]);
    expect(configWarnings({ ...reachable, TARFA_HOST: '0.0.0.0' })).toEqual([
      'TARFA_HOST=0.0.0.0 is ignored: the agent listens on 127.0.0.1 only, and phones reach it through its published phone port',
    ]);
  });

  it('reads the keyterms path override', () => {
    const cfg = loadConfig({ ...base, TARFA_KEYTERMS_PATH: '/home/u/dotfiles/stt/keyterms.txt' }, '/home/u');
    expect(cfg.keytermsPath).toBe('/home/u/dotfiles/stt/keyterms.txt');
  });

  it('reads the default path pairing links carry, and has none unless TARFA_DEFAULT_PATH is set', () => {
    expect(loadConfig({ ...base, TARFA_DEFAULT_PATH: '/home/u/workspace' }, '/home/u').defaultPath).toBe('/home/u/workspace');
    expect(loadConfig({ ...base, TARFA_PROJECT_ROOTS: '/a:/b' }, '/home/u').defaultPath).toBeUndefined();
  });

  it('parses colon-separated project roots', () => {
    const cfg = loadConfig({ ...base, TARFA_PROJECT_ROOTS: '/a:/b/c' }, '/home/u');
    expect(cfg.projectRoots).toEqual(['/a', '/b/c']);
  });

  it('reads the hooks port override, and has no listen address to override', () => {
    const cfg = loadConfig({ ...base, TARFA_HOST: '0.0.0.0', TARFA_PORT: '9000' }, '/home/u');
    expect(cfg.port).toBe(9000);
    expect('host' in cfg).toBe(false);
  });

  it('does NOT require TARFA_TOKEN (CLI usage)', () => {
    const cfg = loadConfig({ TARFA_MACHINE_ID: 'mini' }, '/home/u');
    expect(cfg.token).toBeUndefined();
  });

  it('throws when TARFA_MACHINE_ID is missing', () => {
    expect(() => loadConfig({ TARFA_TOKEN: 'secret' }, '/home/u')).toThrow(/TARFA_MACHINE_ID/);
  });

  it('throws when TARFA_PORT is not a number', () => {
    expect(() => loadConfig({ ...base, TARFA_PORT: 'abc' }, '/home/u')).toThrow(/TARFA_PORT/);
  });
});

describe('assertServerConfig', () => {
  it('passes when a token is present', () => {
    expect(() => assertServerConfig(loadConfig(base, '/home/u'))).not.toThrow();
  });

  it('throws when the token is missing', () => {
    expect(() => assertServerConfig(loadConfig({ TARFA_MACHINE_ID: 'mini' }, '/home/u'))).toThrow(
      /TARFA_TOKEN/,
    );
  });
});

describe('legacy PERCH_ names', () => {
  const legacy = { PERCH_MACHINE_ID: 'mini', PERCH_TOKEN: 'secret', PERCH_PHONE_PORT: '9100' };

  it('reads an agent.env that still names PERCH_*', () => {
    const cfg = loadConfig(legacy, '/home/u');
    expect([cfg.machineId, cfg.token, cfg.phonePort]).toEqual(['mini', 'secret', 9100]);
  });

  it('prefers the TARFA_ name when both are set', () => {
    expect(loadConfig({ ...legacy, TARFA_MACHINE_ID: 'new' }, '/home/u').machineId).toBe('new');
  });

  it('warns once per legacy name, and not for one its TARFA_ name overrides', () => {
    const warnings = configWarnings({ ...legacy, TARFA_TOKEN: 'secret', TARFA_PHONE_ADDRESSES: 'wss://a.example.ts.net' });
    expect(warnings).toEqual([
      'PERCH_MACHINE_ID is read as TARFA_MACHINE_ID for one release: rename it in deploy/agent.env (tarfa setup does)',
      'PERCH_PHONE_PORT is read as TARFA_PHONE_PORT for one release: rename it in deploy/agent.env (tarfa setup does)',
    ]);
  });
});
