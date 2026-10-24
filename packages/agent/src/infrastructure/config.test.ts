import { describe, it, expect } from 'vitest';
import { loadConfig, assertServerConfig, configWarnings } from './config';

const base = { PERCH_MACHINE_ID: 'mini', PERCH_TOKEN: 'secret' };
const relayed = { ...base, PERCH_RELAY_URLS: 'wss://relay.example.com' };

describe('loadConfig', () => {
  it('applies defaults from the home directory', () => {
    const cfg = loadConfig(base, '/home/u');
    expect(cfg).toEqual({
      machineId: 'mini',
      token: 'secret',
      port: 8787,
      projectRoots: ['/home/u/workspace'],
      recentStorePath: '/home/u/.perch/recent.json',
      statusStorePath: '/home/u/.perch/status.json',
      hiddenFoldersPath: '/home/u/.perch/hidden-folders.json',
      commandsPath: '/home/u/.perch/commands.json',
      launchersPath: '/home/u/.perch/launchers.json',
      keytermsPath: '/home/u/.perch/keyterms.txt',
      clientLogPath: '/home/u/.perch/client-log.jsonl',
      hookEventLogPath: '/home/u/.perch/hook-events.jsonl',
      workspaceLogPath: '/home/u/.perch/workspace-log.jsonl',
      parkedStorePath: '/home/u/.perch/parked.json',
      liveSnapshotPath: '/home/u/.perch/live.json',
      relayUrls: [],
      relayKeyPath: '/home/u/.perch/relay-key.json',
      devicesPath: '/home/u/.perch/devices.json',
      pairingPath: '/home/u/.perch/pairing.json',
      claudeSessionsDir: '/home/u/.claude/sessions',
      sessionPrefix: 'perch-',
    });
  });

  it('has no relay unless PERCH_RELAY_URLS is set; the old PERCH_RELAY_URL is not read', () => {
    expect(loadConfig(base, '/home/u').relayUrls).toEqual([]);
    expect(loadConfig({ ...base, PERCH_RELAY_URLS: ' , ' }, '/home/u').relayUrls).toEqual([]);
    expect(loadConfig({ ...base, PERCH_RELAY_URL: 'wss://relay.example.com' }, '/home/u').relayUrls).toEqual([]);
    const cfg = loadConfig({ ...base, PERCH_RELAY_URLS: 'wss://relay.example.com' }, '/home/u');
    expect(cfg.relayUrls).toEqual(['wss://relay.example.com']);
    expect(cfg.relayKeyPath).toBe('/home/u/.perch/relay-key.json');
  });

  it('holds every relay listed, comma- or space-separated, once each', () => {
    const cfg = loadConfig(
      { ...base, PERCH_RELAY_URLS: 'wss://relay-dev.example.com/, wss://relay.example.com\n ws://127.0.0.1:8450 wss://relay.example.com/' },
      '/home/u',
    );
    expect(cfg.relayUrls).toEqual(['wss://relay-dev.example.com', 'wss://relay.example.com', 'ws://127.0.0.1:8450']);
  });

  it('drops a ws:// relay that is not on loopback, and says so', () => {
    const env = { ...base, PERCH_RELAY_URLS: 'ws://relay.example.com wss://relay.example.com ws://127.0.0.1:8450' };
    expect(loadConfig(env, '/home/u').relayUrls).toEqual(['wss://relay.example.com', 'ws://127.0.0.1:8450']);
    expect(configWarnings(env)).toEqual([
      'ws://relay.example.com is ignored: a relay off this machine must be wss://, or its upgrades travel in the clear',
    ]);
  });

  it('warns that PERCH_RELAY_URL is ignored, only when it is set', () => {
    expect(configWarnings(relayed)).toEqual([]);
    expect(configWarnings({ ...relayed, PERCH_RELAY_URL: 'wss://relay.example.com' })).toEqual([
      'PERCH_RELAY_URL is ignored: move wss://relay.example.com into PERCH_RELAY_URLS in deploy/agent.env',
    ]);
  });

  it('warns that no phone can reach an agent with no relay', () => {
    expect(configWarnings(base)).toEqual(['no relay in PERCH_RELAY_URLS: no phone can reach this agent (see `perch connect`)']);
  });

  it('warns that a non-loopback PERCH_HOST is ignored', () => {
    expect(configWarnings({ ...relayed, PERCH_HOST: '127.0.0.1' })).toEqual([]);
    expect(configWarnings({ ...relayed, PERCH_HOST: '0.0.0.0' })).toEqual([
      'PERCH_HOST=0.0.0.0 is ignored: the agent listens on 127.0.0.1 only, and phones reach it through its relays',
    ]);
  });

  it('warns that PERCH_RELAY_ALLOW_NK no longer does anything', () => {
    expect(configWarnings({ PERCH_RELAY_ALLOW_NK: 'off', PERCH_RELAY_URLS: 'wss://r' })).toEqual([
      'PERCH_RELAY_ALLOW_NK is ignored: phones without a device key are no longer served; remove it from deploy/agent.env',
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
