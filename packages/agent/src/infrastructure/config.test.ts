import { describe, it, expect } from 'vitest';
import { loadConfig, assertServerConfig, configWarnings } from './config';

const base = { PERCH_MACHINE_ID: 'mini', PERCH_TOKEN: 'secret' };
const reachable = { ...base, PERCH_PHONE_ADDRESSES: 'wss://a.example.ts.net' };

describe('loadConfig', () => {
  it('takes PERCH_PWA_ORIGIN over the tarfa.app default', () => {
    expect(loadConfig({ ...base, PERCH_PWA_ORIGIN: 'https://self.example' }, '/home/u').pwaOrigin).toBe('https://self.example');
  });

  it('applies defaults from the home directory', () => {
    const cfg = loadConfig(base, '/home/u');
    expect(cfg).toEqual({
      machineId: 'mini',
      token: 'secret',
      port: 8787,
      projectRoots: ['/home/u/workspace'],
      pwaOrigin: 'https://tarfa.app',
      recentStorePath: '/home/u/.perch/recent.json',
      statusStorePath: '/home/u/.perch/status.json',
      hiddenFoldersPath: '/home/u/.perch/hidden-folders.json',
      launchersPath: '/home/u/.perch/launchers.json',
      keytermsPath: '/home/u/.perch/keyterms.txt',
      clientLogPath: '/home/u/.perch/client-log.jsonl',
      hookEventLogPath: '/home/u/.perch/hook-events.jsonl',
      messageLogPath: '/home/u/.perch/messages.jsonl',
      workspaceLogPath: '/home/u/.perch/workspace-log.jsonl',
      parkedStorePath: '/home/u/.perch/parked.json',
      liveSnapshotPath: '/home/u/.perch/live.json',
      agentKeyPath: '/home/u/.perch/relay-key.json',
      devicesPath: '/home/u/.perch/devices.json',
      pairingPath: '/home/u/.perch/pairing.json',
      claudeSessionsDir: '/home/u/.claude/sessions',
      inboxDir: '/home/u/.perch/inbox',
      sessionPrefix: 'perch-',
      phonePort: 8797,
      phoneAddresses: [],
    });
  });

  it('reads the phone port and the addresses phones reach it by', () => {
    const cfg = loadConfig({ ...base, PERCH_PHONE_PORT: '9100', PERCH_PHONE_ADDRESSES: ' wss://a.example.ts.net/x , ,wss://b.example.com ' }, '/home/u');
    expect(cfg.phonePort).toBe(9100);
    expect(cfg.phoneAddresses).toEqual(['wss://a.example.ts.net/x', 'wss://b.example.com']);
  });

  it('throws when PERCH_PHONE_PORT is not a port number', () => {
    for (const bad of ['abc', '8797.5', '0', '65536', '-1', '80x']) {
      expect(() => loadConfig({ ...base, PERCH_PHONE_PORT: bad }, '/home/u')).toThrow(/PERCH_PHONE_PORT/);
    }
  });

  it('sends the machine load unless PERCH_STATS turns it off', () => {
    expect(loadConfig(base, '/home/u').stats).toBeUndefined();
    for (const off of ['off', '0', 'false', ' OFF ']) {
      expect(loadConfig({ ...base, PERCH_STATS: off }, '/home/u').stats).toBe(false);
    }
    expect(loadConfig({ ...base, PERCH_STATS: 'on' }, '/home/u').stats).toBeUndefined();
  });

  it('plays Claude voice into the loopback subdevice PERCH_VOICE_DEVICE names', () => {
    expect(loadConfig(base, '/home/u').voiceDevice).toBeUndefined();
    expect(loadConfig({ ...base, PERCH_VOICE_DEVICE: ' ' }, '/home/u').voiceDevice).toBeUndefined();
    expect(loadConfig({ ...base, PERCH_VOICE_DEVICE: ' plughw:Loopback,0,1 ' }, '/home/u').voiceDevice).toBe('plughw:Loopback,0,1');
  });

  it('starts with relays still listed, and says once that they are gone', () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ PERCH_RELAY_URLS: 'wss://relay.example.com, ws://127.0.0.1:8450' }, 'PERCH_RELAY_URLS'],
      [{ PERCH_RELAY_URL: 'wss://relay.example.com' }, 'PERCH_RELAY_URL'],
      [{ PERCH_RELAY_URLS: 'wss://relay.example.com', PERCH_RELAY_URL: 'wss://old.example.com' }, 'PERCH_RELAY_URLS and PERCH_RELAY_URL'],
    ];
    for (const [relays, named] of cases) {
      const env = { ...reachable, ...relays };
      expect('relayUrls' in loadConfig(env, '/home/u')).toBe(false);
      expect(configWarnings(env)).toEqual([`relays are gone; remove ${named} from deploy/agent.env`]);
    }
    expect(configWarnings({ ...reachable, PERCH_RELAY_URLS: ' ' })).toEqual([]);
  });

  it('warns that phones reach an agent with no phone address only once its phone port is published', () => {
    expect(configWarnings(base)).toEqual([
      'no PERCH_PHONE_ADDRESSES: phones reach this agent only once its phone port is published (tailscale serve, a reverse proxy)',
    ]);
    expect(configWarnings({ ...base, PERCH_PHONE_ADDRESSES: 'wss://a.example.ts.net' })).toEqual([]);
  });

  it('warns that a non-loopback PERCH_HOST is ignored', () => {
    expect(configWarnings({ ...reachable, PERCH_HOST: '127.0.0.1' })).toEqual([]);
    expect(configWarnings({ ...reachable, PERCH_HOST: '0.0.0.0' })).toEqual([
      'PERCH_HOST=0.0.0.0 is ignored: the agent listens on 127.0.0.1 only, and phones reach it through its published phone port',
    ]);
  });

  it('reads the keyterms path override', () => {
    const cfg = loadConfig({ ...base, PERCH_KEYTERMS_PATH: '/home/u/dotfiles/stt/keyterms.txt' }, '/home/u');
    expect(cfg.keytermsPath).toBe('/home/u/dotfiles/stt/keyterms.txt');
  });

  it('reads the default path pairing links carry, and has none unless PERCH_DEFAULT_PATH is set', () => {
    expect(loadConfig({ ...base, PERCH_DEFAULT_PATH: '/home/u/workspace' }, '/home/u').defaultPath).toBe('/home/u/workspace');
    expect(loadConfig({ ...base, PERCH_PROJECT_ROOTS: '/a:/b' }, '/home/u').defaultPath).toBeUndefined();
  });

  it('parses colon-separated project roots', () => {
    const cfg = loadConfig({ ...base, PERCH_PROJECT_ROOTS: '/a:/b/c' }, '/home/u');
    expect(cfg.projectRoots).toEqual(['/a', '/b/c']);
  });

  it('reads the hooks port override, and has no listen address to override', () => {
    const cfg = loadConfig({ ...base, PERCH_HOST: '0.0.0.0', PERCH_PORT: '9000' }, '/home/u');
    expect(cfg.port).toBe(9000);
    expect('host' in cfg).toBe(false);
  });

  it('does NOT require PERCH_TOKEN (CLI usage)', () => {
    const cfg = loadConfig({ PERCH_MACHINE_ID: 'mini' }, '/home/u');
    expect(cfg.token).toBeUndefined();
  });

  it('throws when PERCH_MACHINE_ID is missing', () => {
    expect(() => loadConfig({ PERCH_TOKEN: 'secret' }, '/home/u')).toThrow(/PERCH_MACHINE_ID/);
  });

  it('throws when PERCH_PORT is not a number', () => {
    expect(() => loadConfig({ ...base, PERCH_PORT: 'abc' }, '/home/u')).toThrow(/PERCH_PORT/);
  });
});

describe('assertServerConfig', () => {
  it('passes when a token is present', () => {
    expect(() => assertServerConfig(loadConfig(base, '/home/u'))).not.toThrow();
  });

  it('throws when the token is missing', () => {
    expect(() => assertServerConfig(loadConfig({ PERCH_MACHINE_ID: 'mini' }, '/home/u'))).toThrow(
      /PERCH_TOKEN/,
    );
  });
});
