import { describe, it, expect } from 'vitest';
import { SettingsStore, isConnectable } from './settings-store';
import { DEFAULT_PRESETS } from './dictation-presets';
import type { StoragePort } from './ports/storage';
import { generateAgentKeys } from '@tarfa/secure-channel';

const agentKey = generateAgentKeys().x25519.publicKey;

function memStorage(): StoragePort {
  const map = new Map<string, string>();
  return {
    read: (k) => map.get(k) ?? null,
    write: (k, v) => {
      map.set(k, v);
    },
  };
}

describe('SettingsStore', () => {
  it('starts empty', () => {
    expect(new SettingsStore(memStorage()).list()).toEqual([]);
  });

  it('defaults file word-wrap to on', () => {
    expect(new SettingsStore(memStorage()).fileWrap()).toBe(true);
  });

  it('persists the file word-wrap preference', () => {
    const storage = memStorage();
    const store = new SettingsStore(storage);
    store.setFileWrap(false);
    expect(store.fileWrap()).toBe(false);
    expect(new SettingsStore(storage).fileWrap()).toBe(false);
    store.setFileWrap(true);
    expect(new SettingsStore(storage).fileWrap()).toBe(true);
  });

  it('defaults sharing terminal links to off', () => {
    expect(new SettingsStore(memStorage()).shareLinks()).toBe(false);
  });

  it('persists the share-links preference', () => {
    const storage = memStorage();
    const store = new SettingsStore(storage);
    store.setShareLinks(true);
    expect(new SettingsStore(storage).shareLinks()).toBe(true);
    store.setShareLinks(false);
    expect(new SettingsStore(storage).shareLinks()).toBe(false);
  });

  it('follows the phone language until one is picked, and persists the pick', () => {
    const storage = memStorage();
    expect(new SettingsStore(storage).languageChoice()).toBe('auto');
    new SettingsStore(storage).setLanguageChoice('fr');
    expect(new SettingsStore(storage).languageChoice()).toBe('fr');
  });

  it('defaults the terminal font size to 13', () => {
    expect(new SettingsStore(memStorage()).terminalFontSize()).toBe(13);
  });

  it('persists the terminal font size across a fresh store', () => {
    const storage = memStorage();
    const store = new SettingsStore(storage);
    store.setTerminalFontSize(18);
    expect(store.terminalFontSize()).toBe(18);
    expect(new SettingsStore(storage).terminalFontSize()).toBe(18);
  });

  it('clamps an out-of-range or unparsable stored font size on read', () => {
    const storage = memStorage();
    storage.write('tarfa.terminalFontSize', '999');
    expect(new SettingsStore(storage).terminalFontSize()).toBe(24);
    storage.write('tarfa.terminalFontSize', '1');
    expect(new SettingsStore(storage).terminalFontSize()).toBe(8);
    storage.write('tarfa.terminalFontSize', 'abc');
    expect(new SettingsStore(storage).terminalFontSize()).toBe(13);
  });

  it('adds and lists machines, persisting to storage', () => {
    const storage = memStorage();
    const store = new SettingsStore(storage);
    store.add({ id: 'mac', name: 'MacBook', addresses: ['wss://mac.ts.net/'], token: 't1', agentKey });
    store.add({ id: 'mini', name: 'Mini PC', addresses: ['wss://mini.ts.net/'], token: 't2', agentKey });
    expect(store.list().map((m) => m.id)).toEqual(['mac', 'mini']);
    // a fresh store over the same storage sees the persisted machines
    expect(new SettingsStore(storage).list()).toHaveLength(2);
  });

  it('replaces an existing machine with the same id on add', () => {
    const store = new SettingsStore(memStorage());
    store.add({ id: 'mac', name: 'Old', addresses: ['wss://old/'], token: 't', agentKey });
    store.add({ id: 'mac', name: 'New', addresses: ['wss://new/'], token: 't', agentKey });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.name).toBe('New');
  });

  it('updates the addresses and token of an existing machine, preserving id, name and key', () => {
    const store = new SettingsStore(memStorage());
    store.add({ id: 'mac', name: 'MacBook', addresses: ['wss://old/'], token: 'old', agentKey });
    store.update('mac', { addresses: ['wss://a/', 'wss://b/x'], token: 'new' });
    expect(store.list()).toEqual([{ id: 'mac', name: 'MacBook', addresses: ['wss://a/', 'wss://b/x'], token: 'new', agentKey }]);
  });

  it('keeps the existing token and agent key when update omits them', () => {
    const store = new SettingsStore(memStorage());
    store.add({ id: 'mac', name: 'MacBook', addresses: ['wss://old/'], token: 'keepme', agentKey });
    store.update('mac', { addresses: ['wss://new/'] });
    expect(store.list()[0]).toEqual({ id: 'mac', name: 'MacBook', addresses: ['wss://new/'], token: 'keepme', agentKey });
    const other = generateAgentKeys().x25519.publicKey;
    store.update('mac', { addresses: ['wss://new/'], agentKey: other });
    expect(store.list()[0]?.agentKey).toBe(other);
  });

  it('leaves other machines untouched on update', () => {
    const store = new SettingsStore(memStorage());
    store.add({ id: 'mac', name: 'Mac', addresses: ['wss://mac/'], token: 't1', agentKey });
    store.add({ id: 'mini', name: 'Mini', addresses: ['wss://mini/'], token: 't2', agentKey });
    store.update('mac', { addresses: ['wss://mac2/'], token: 't1b' });
    expect(store.list()).toEqual([
      { id: 'mac', name: 'Mac', addresses: ['wss://mac2/'], token: 't1b', agentKey },
      { id: 'mini', name: 'Mini', addresses: ['wss://mini/'], token: 't2', agentKey },
    ]);
  });

  it('is a no-op when updating an unknown id', () => {
    const store = new SettingsStore(memStorage());
    store.add({ id: 'mac', name: 'Mac', addresses: ['wss://mac/'], token: 't', agentKey });
    store.update('ghost', { addresses: ['wss://nope/'], token: 'x' });
    expect(store.list()).toEqual([{ id: 'mac', name: 'Mac', addresses: ['wss://mac/'], token: 't', agentKey }]);
  });

  it('round-trips an optional default path through add and list', () => {
    const storage = memStorage();
    const store = new SettingsStore(storage);
    store.add({ id: 'mac', name: 'Mac', addresses: ['wss://mac/'], token: 't', agentKey, defaultPath: '/home/u/ws' });
    expect(new SettingsStore(storage).list()[0]?.defaultPath).toBe('/home/u/ws');
  });

  it('updates the default path of an existing machine', () => {
    const store = new SettingsStore(memStorage());
    store.add({ id: 'mac', name: 'Mac', addresses: ['wss://mac/'], token: 't', agentKey, defaultPath: '/old' });
    store.update('mac', { addresses: ['wss://mac/'], defaultPath: '/new' });
    expect(store.list()[0]?.defaultPath).toBe('/new');
  });

  it('clears the default path when update passes an empty string', () => {
    const store = new SettingsStore(memStorage());
    store.add({ id: 'mac', name: 'Mac', addresses: ['wss://mac/'], token: 't', agentKey, defaultPath: '/old' });
    store.update('mac', { addresses: ['wss://mac/'], defaultPath: '' });
    expect(store.list()[0]?.defaultPath).toBe('');
  });

  it('connects a switched-on entry with a valid agent key and at least one valid address', () => {
    const addresses = ['wss://dev.example.ts.net:10000/abu'];
    expect(isConnectable({ agentKey, addresses })).toBe(true);
    expect(isConnectable({ agentKey, addresses, enabled: true })).toBe(true);
    expect(isConnectable({ agentKey, addresses, enabled: false })).toBe(false);
    expect(isConnectable({ agentKey: agentKey.slice(0, 40), addresses })).toBe(false);
    expect(isConnectable({ agentKey: '', addresses })).toBe(false);
    expect(isConnectable({ agentKey, addresses: [] })).toBe(false);
    expect(isConnectable({ agentKey, addresses: ['https://dev.example/'] })).toBe(false);
    // An entry shaped by an older build (a url, no addresses) is never connected.
    expect(isConnectable({ agentKey } as never)).toBe(false);
  });

  it('removes a machine by id', () => {
    const store = new SettingsStore(memStorage());
    store.add({ id: 'mac', name: 'M', addresses: ['wss://m/'], token: 't', agentKey });
    store.remove('mac');
    expect(store.list()).toEqual([]);
  });

  it('returns [] on corrupt storage', () => {
    const storage = memStorage();
    storage.write('tarfa.machines', 'not json');
    expect(new SettingsStore(storage).list()).toEqual([]);
  });

  it('round-trips the enabled flag through setEnabled', () => {
    const storage = memStorage();
    const store = new SettingsStore(storage);
    store.add({ id: 'mac', name: 'Mac', addresses: ['wss://mac/'], token: 't', agentKey });
    store.setEnabled('mac', false);
    expect(new SettingsStore(storage).list()[0]?.enabled).toBe(false);
    store.setEnabled('mac', true);
    expect(new SettingsStore(storage).list()[0]?.enabled).toBe(true);
  });

  it('is a no-op when setEnabled targets an unknown id', () => {
    const store = new SettingsStore(memStorage());
    store.add({ id: 'mac', name: 'Mac', addresses: ['wss://mac/'], token: 't', agentKey });
    store.setEnabled('ghost', false);
    expect(store.list()).toEqual([{ id: 'mac', name: 'Mac', addresses: ['wss://mac/'], token: 't', agentKey }]);
  });

  it('preserves the enabled flag through an unrelated update', () => {
    const store = new SettingsStore(memStorage());
    store.add({ id: 'mac', name: 'Mac', addresses: ['wss://mac/'], token: 't', agentKey });
    store.setEnabled('mac', false);
    store.update('mac', { addresses: ['wss://mac2/'] });
    expect(store.list()[0]?.enabled).toBe(false);
  });

  it('defaults the ElevenLabs API key to null', () => {
    expect(new SettingsStore(memStorage()).elevenLabsApiKey()).toBeNull();
  });

  it('persists the ElevenLabs API key across a fresh store', () => {
    const storage = memStorage();
    const store = new SettingsStore(storage);
    store.setElevenLabsApiKey('sk_test');
    expect(store.elevenLabsApiKey()).toBe('sk_test');
    expect(new SettingsStore(storage).elevenLabsApiKey()).toBe('sk_test');
  });

  it('clears the ElevenLabs API key when set to empty', () => {
    const storage = memStorage();
    const store = new SettingsStore(storage);
    store.setElevenLabsApiKey('sk_test');
    store.setElevenLabsApiKey('');
    expect(new SettingsStore(storage).elevenLabsApiKey()).toBeNull();
  });

  it('persists and reads the last used machine', () => {
    const storage = memStorage();
    const store = new SettingsStore(storage);
    expect(store.lastMachine()).toBeNull();
    store.setLastMachine('mini');
    expect(store.lastMachine()).toBe('mini');
    // a fresh store over the same storage sees the persisted last machine
    expect(new SettingsStore(storage).lastMachine()).toBe('mini');
  });

  it('persists and reads the last used command', () => {
    const storage = memStorage();
    const store = new SettingsStore(storage);
    expect(store.lastCommand()).toBeNull();
    store.setLastCommand('codex');
    expect(store.lastCommand()).toBe('codex');
    // a fresh store over the same storage sees the persisted last command
    expect(new SettingsStore(storage).lastCommand()).toBe('codex');
  });

  it('defaults the folder filter to empty', () => {
    expect(new SettingsStore(memStorage()).folderFilter()).toEqual([]);
  });

  it('persists the folder filter across a fresh store', () => {
    const storage = memStorage();
    const store = new SettingsStore(storage);
    store.setFolderFilter(['api', 'web']);
    expect(store.folderFilter()).toEqual(['api', 'web']);
    expect(new SettingsStore(storage).folderFilter()).toEqual(['api', 'web']);
  });

  it('overwrites a previous folder filter selection', () => {
    const storage = memStorage();
    const store = new SettingsStore(storage);
    store.setFolderFilter(['api']);
    store.setFolderFilter([]);
    expect(new SettingsStore(storage).folderFilter()).toEqual([]);
  });

  it('returns [] on a corrupt folder filter value', () => {
    const storage = memStorage();
    storage.write('tarfa.folderFilter', 'not json');
    expect(new SettingsStore(storage).folderFilter()).toEqual([]);
  });

  it('defaults the hidden folders to empty', () => {
    expect(new SettingsStore(memStorage()).folderHidden()).toEqual([]);
  });

  it('persists the hidden folders across a fresh store', () => {
    const storage = memStorage();
    new SettingsStore(storage).setFolderHidden(['acme']);
    expect(new SettingsStore(storage).folderHidden()).toEqual(['acme']);
  });

  it('returns [] on a corrupt hidden folders value', () => {
    const storage = memStorage();
    storage.write('tarfa.folderHidden', 'not json');
    expect(new SettingsStore(storage).folderHidden()).toEqual([]);
  });

  it('keeps the show-only and hidden selections independent', () => {
    // Sticky hides must survive a transient "show only" focus, so the two sets are separate
    // keys rather than one set reinterpreted by the mode.
    const storage = memStorage();
    const store = new SettingsStore(storage);
    store.setFolderHidden(['acme']);
    store.setFolderFilter(['tarfa']);
    expect(store.folderHidden()).toEqual(['acme']);
    expect(store.folderFilter()).toEqual(['tarfa']);
  });

  it('defaults the filter mode to show-only', () => {
    expect(new SettingsStore(memStorage()).folderFilterMode()).toBe('only');
  });

  it('persists the filter mode across a fresh store', () => {
    const storage = memStorage();
    new SettingsStore(storage).setFolderFilterMode('hide');
    expect(new SettingsStore(storage).folderFilterMode()).toBe('hide');
  });

  it('falls back to show-only on an unrecognised filter mode', () => {
    const storage = memStorage();
    storage.write('tarfa.folderFilterMode', 'sideways');
    expect(new SettingsStore(storage).folderFilterMode()).toBe('only');
  });
});

describe('SettingsStore dictation presets', () => {
  it('returns the built-in defaults when nothing is stored', () => {
    expect(new SettingsStore(memStorage()).dictationPresets()).toEqual(DEFAULT_PRESETS);
  });

  it('round-trips a stored list, and null restores the defaults', () => {
    const storage = memStorage();
    const store = new SettingsStore(storage);
    const list = [DEFAULT_PRESETS[1]!];
    store.setDictationPresets(list);
    expect(new SettingsStore(storage).dictationPresets()).toEqual(list);
    store.setDictationPresets(null);
    expect(new SettingsStore(storage).dictationPresets()).toEqual(DEFAULT_PRESETS);
  });

  it('remembers the current preset id', () => {
    const storage = memStorage();
    expect(new SettingsStore(storage).currentPresetId()).toBeNull();
    new SettingsStore(storage).setCurrentPresetId('clean');
    expect(new SettingsStore(storage).currentPresetId()).toBe('clean');
  });

  it('round-trips the OpenRouter key, empty clearing it', () => {
    const storage = memStorage();
    const store = new SettingsStore(storage);
    expect(store.openRouterApiKey()).toBeNull();
    store.setOpenRouterApiKey('sk-or-x');
    expect(new SettingsStore(storage).openRouterApiKey()).toBe('sk-or-x');
    store.setOpenRouterApiKey('');
    expect(new SettingsStore(storage).openRouterApiKey()).toBeNull();
  });
});
