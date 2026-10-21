import { generateAgentKeys, pairingLink } from '@perch/secure-channel';
import { audioMediaType, imageMediaType, pdfMediaType } from '@perch/contracts';
import { describe, it, expect, vi } from 'vitest';
import { PerchStore } from './store.svelte';
import { ConnectionManager } from './core/connection-manager';
import { WorkspaceAggregator } from './core/workspace-aggregator';
import { SettingsStore, type MachineConfig } from './core/settings-store';
import { UnreadableDeviceKeyError } from './core/ports/device-identity';
import type { StoragePort } from './core/ports/storage';
import type { Socket } from './core/ports/socket';
import type { CacheLike } from './core/shared-file';
import { MAX_UPLOAD_BYTES } from './core/upload-limit';

function fakeCache(bytes: Uint8Array, name: string): CacheLike & { deleteCount: () => number } {
  const res = {
    arrayBuffer: async () => {
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      return ab;
    },
    headers: { get: (k: string) => (k.toLowerCase() === 'x-filename' ? name : null) },
  };
  let present = true;
  let deletes = 0;
  return {
    deleteCount: () => deletes,
    match: async () => (present ? res : undefined),
    delete: async () => ((present = false), (deletes += 1), true),
  };
}

// A tapped pairing link is declined unless a test answers otherwise.
let nextId = 0;
const prompts = { confirm: () => false, alert: () => undefined, newId: () => `id${(nextId += 1)}` };

function memStorage(seed: unknown[] = []): StoragePort {
  const map = new Map<string, string>();
  if (seed.length) map.set('perch.machines', JSON.stringify(seed));
  return { read: (k) => map.get(k) ?? null, write: (k, v) => void map.set(k, v) };
}

// A timer the test drives by hand, so grace-period transitions are deterministic.
function manualTimer() {
  const entries: { fn: () => void }[] = [];
  return {
    startTimer: (fn: () => void) => {
      const entry = { fn };
      entries.push(entry);
      return () => {
        const i = entries.indexOf(entry);
        if (i >= 0) entries.splice(i, 1);
      };
    },
    pending: () => entries.length,
    fireAll: () => {
      for (const entry of entries.splice(0)) entry.fn();
    },
  };
}

function build(
  seed: unknown[] = [],
  applyUpdate?: () => void,
  startTimer?: (fn: () => void, ms: number) => () => void,
  log?: { connectionLog: import('./core/connection-log').ConnectionLog },
  ask: { confirm?: (message: string) => boolean; alert?: (message: string) => void } = {},
) {
  const sockets: Record<string, { open: () => void; deliver: (m: unknown) => void; sent: string[] }> = {};
  const aggregator = new WorkspaceAggregator();
  const storage = memStorage(seed);
  const settings = new SettingsStore(storage);
  const socketFactory = (url: string) => {
    let onMessage: (d: string) => void = () => undefined;
    let onOpen: () => void = () => undefined;
    const sent: string[] = [];
    const socket: Socket = {
      send: (d) => sent.push(d),
      close: () => undefined,
      onMessage: (cb) => void (onMessage = cb),
      onOpen: (cb) => void (onOpen = cb),
      onClose: () => undefined,
    };
    sockets[url] = { open: () => onOpen(), deliver: (m) => onMessage(JSON.stringify(m)), sent };
    return socket;
  };
  const manager = new ConnectionManager({
    secureSocketFactory: () => socketFactory,
    aggregator,
    onMessage: (id, m) => store.handleMessage(id, m),
    onStatus: (id, s) => {
      store.statuses[id] = s;
    },
    onCredentialsSpent: (id, scope) => store.forgetCredentials(id, scope),
    schedule: () => undefined,
  });
  const store = new PerchStore({ settings, manager, aggregator, applyUpdate, startTimer, origin: 'https://pwa.example', ...prompts, ...log, ...ask });
  return { store, sockets, manager, storage };
}

const agentKey = generateAgentKeys().x25519.publicKey;
const mac = { id: 'mac', name: 'Mac', url: 'wss://mac', token: 't', agentKey };

describe('PerchStore pairing', () => {
  const link = pairingLink('https://pwa.example', {
    url: 'wss://relay.example/acct',
    agentKey: generateAgentKeys().x25519.publicKey,
    secret: 'S'.repeat(43),
    name: 'dev',
  });

  it('adds the machine from a pairing link and goes home to watch it connect', () => {
    const { store } = build();
    store.start();
    store.goSettings();
    expect(store.pairFromLink(`  ${link}\n`)).toEqual({ name: 'dev' });
    expect(store.machines).toEqual([expect.objectContaining({ name: 'dev', url: 'wss://relay.example/acct', token: '', pairing: 'S'.repeat(43) })]);
    expect(store.view).toBe('list');
  });

  it("forgets a hand-added entry's token once the agent says its device key is enrolled", () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true, credential: 'token', enrolled: true });
    expect(store.machines).toEqual([expect.objectContaining({ id: 'mac', token: '' })]);
  });

  it('refuses a pairing link made for another Perch, and stores nothing', () => {
    const { store } = build();
    store.start();
    const foreign = link.replace('https://pwa.example', 'https://elsewhere.example');
    expect(store.pairFromLink(foreign)).toEqual({ error: expect.stringContaining('elsewhere.example') });
    expect(store.machines).toEqual([]);
  });

  it('refuses anything that is not a pairing link, and stores nothing', () => {
    const { store } = build();
    store.start();
    expect(store.pairFromLink('https://pwa.example/#pair?u=wss://x/acct')).toEqual({ error: expect.stringMatching(/not a Perch pairing code/) });
    expect(store.machines).toEqual([]);
  });

  it('handles a pairing link tapped inside the app in place: asks, then adds the machine', () => {
    const asked: string[] = [];
    const { store } = build([], undefined, undefined, undefined, { confirm: (m) => (asked.push(m), true) });
    store.start();
    expect(store.openPairingLink(link)).toBe(true);
    expect(asked).toEqual([expect.stringContaining('Pair with dev through relay.example?')]);
    expect(store.machines).toEqual([expect.objectContaining({ name: 'dev', pairing: 'S'.repeat(43) })]);
  });

  it('adds nothing from a tapped pairing link the owner declines', () => {
    const { store } = build([], undefined, undefined, undefined, { confirm: () => false });
    store.start();
    expect(store.openPairingLink(link)).toBe(true);
    expect(store.machines).toEqual([]);
  });

  it('holds a pairing link opened outside the installed app, and pairs here only when asked', () => {
    const asked: string[] = [];
    const { store } = build([], undefined, undefined, undefined, { confirm: (m) => (asked.push(m), true) });
    store.start();
    store.holdForInstall(link);
    expect(store.installFirst).toEqual({ name: 'dev', link });
    expect(store.machines).toEqual([]);
    store.pairInBrowser();
    expect(asked).toEqual([expect.stringContaining('Pair with dev')]);
    expect(store.machines).toEqual([expect.objectContaining({ name: 'dev', pairing: 'S'.repeat(43) })]);
    expect(store.installFirst).toBeNull();
  });

  it('holds nothing for a link that is not a pairing link', () => {
    const { store } = build();
    store.holdForInstall('https://pwa.example/');
    expect(store.installFirst).toBeNull();
  });

  it('leaves any other link to the browser', () => {
    const { store } = build([], undefined, undefined, undefined, { confirm: () => true });
    expect(store.openPairingLink('https://example.com/#pair')).toBe(false);
    expect(store.openPairingLink('https://example.com/docs')).toBe(false);
  });

  it('says why a tapped pairing link was refused', () => {
    const alerts: string[] = [];
    const other = { id: 'x', name: 'dev', url: 'wss://relay.example/acct', token: '', agentKey: generateAgentKeys().x25519.publicKey };
    const { store } = build([other], undefined, undefined, undefined, { confirm: () => true, alert: (m) => alerts.push(m) });
    store.start();
    expect(store.openPairingLink(link)).toBe(true);
    expect(alerts).toEqual([expect.stringContaining('names another key')]);
  });

  // A pairing link opened in another page context of the app (a new window, the in-app
  // browser) writes the entry there; this one picks it up without a reload.
  it('picks up machine entries another page context wrote, and only reconnects when they changed', () => {
    const { store, storage } = build([mac]);
    store.start();
    const before = store.machines;
    store.refreshMachines();
    expect(store.machines).toBe(before);
    const added = { id: 'dev', name: 'dev', url: 'wss://relay.example/acct', token: '', agentKey: generateAgentKeys().x25519.publicKey };
    storage.write('perch.machines', JSON.stringify([mac, added]));
    store.refreshMachines();
    expect(store.machines.map((m) => m.id)).toEqual(['mac', 'dev']);
  });

  it('forgets the pairing secret once the machine says the key is enrolled', () => {
    const { store, sockets } = build();
    store.start();
    store.pairFromLink(link);
    sockets['wss://relay.example/acct']!.open();
    sockets['wss://relay.example/acct']!.deliver({ type: 'authResult', ok: true, credential: 'pairing', enrolled: true });
    expect(store.machines[0]!.pairing).toBeUndefined();
    expect(JSON.stringify(store.machines)).not.toContain('S'.repeat(43));
  });

  // The agent could not write the enrolment: the code is still the phone's way in.
  it('keeps the pairing secret when the machine says the key is not enrolled', () => {
    const { store, sockets } = build();
    store.start();
    store.pairFromLink(link);
    sockets['wss://relay.example/acct']!.open();
    sockets['wss://relay.example/acct']!.deliver({ type: 'authResult', ok: true, credential: 'pairing', enrolled: false });
    expect(store.machines[0]!.pairing).toBe('S'.repeat(43));
  });
});

describe('PerchStore', () => {
  it('starts, connects machines, and reflects pushed workspaces', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    sockets['wss://mac']!.deliver({
      type: 'workspaces',
      workspaces: [
        { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'needs-feedback' },
      ],
    });
    expect(store.workspaces.map((w) => w.id)).toEqual(['perch-a']);
  });

  it('navigates and routes terminal output to the sink', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
    let out = '';
    store.onOutput = (d) => (out += d);
    store.open(ws);
    expect(store.view).toBe('terminal');
    // Output carries the pty's UTF-8 bytes; non-ASCII (box-drawing, accents) must decode
    // intact, not become mojibake (the bug was atob's latin1 decode).
    store.handleMessage('mac', { type: 'output', workspaceId: 'perch-a', data: Buffer.from('hi─é', 'utf8').toString('base64') });
    expect(out).toBe('hi─é');
  });

  it('sendPutFile sends a base64 putFile for the active workspace', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
    store.open(ws);
    store.sendPutFile('pasted-image.png', new Uint8Array([1, 2, 3]));
    const sent = sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(sent).toContainEqual({
      type: 'putFile',
      workspaceId: 'perch-a',
      name: 'pasted-image.png',
      data: btoa(String.fromCharCode(1, 2, 3)),
    });
  });

  // The cap exists because putFile base64s the whole file over the terminal WebSocket.
  // Rejecting here rather than at each call site covers paste, the picker and the share
  // target at once, since all three funnel through sendPutFile.
  it('sendPutFile refuses an oversized file without touching the socket', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
    store.open(ws);
    const before = sockets['wss://mac']!.sent.length;
    store.sendPutFile('huge.zip', new Uint8Array(MAX_UPLOAD_BYTES + 1));
    expect(sockets['wss://mac']!.sent.length).toBe(before);
    expect(store.actionError).toBe('File is too large to attach (20 MB max)');
  });

  it('sendPutFile accepts a non-image file at the size limit', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
    store.open(ws);
    store.sendPutFile('archive.zip', new Uint8Array(MAX_UPLOAD_BYTES));
    const sent = sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(sent.some((m) => m.type === 'putFile' && m.name === 'archive.zip')).toBe(true);
    expect(store.actionError).toBeNull();
  });

  it('fileStored types the stored path into the terminal as input', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
    store.open(ws);
    store.handleMessage('mac', { type: 'fileStored', workspaceId: 'perch-a', path: '.tmp/files/pasted-image.png' });
    const sent = sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(sent).toContainEqual({
      type: 'input',
      workspaceId: 'perch-a',
      data: btoa(String.fromCharCode(...new TextEncoder().encode('.tmp/files/pasted-image.png'))),
    });
  });

  it('fileStored tells the view before typing the path', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
    store.open(ws);
    const order: string[] = [];
    store.onInjectedInput = () => order.push(`injected after ${sockets['wss://mac']!.sent.length} sends`);
    const before = sockets['wss://mac']!.sent.length;
    store.handleMessage('mac', { type: 'fileStored', workspaceId: 'perch-a', path: 'x.png' });
    expect(order).toEqual([`injected after ${before} sends`]);
    expect(sockets['wss://mac']!.sent.length).toBe(before + 1);
  });

  it('loadSharedFile stashes a shared image as pending without sending OR deleting it', async () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    const c = fakeCache(new Uint8Array([7, 8]), 'shot.png');
    await store.loadSharedFile(c);
    expect(store.pendingSharedFile).toEqual({ name: 'shot.png', bytes: new Uint8Array([7, 8]) });
    expect(sockets['wss://mac']!.sent.map((s) => JSON.parse(s)).some((m) => m.type === 'putFile')).toBe(false);
    // Non-destructive read: the cache entry survives until the image is actually attached, so a
    // re-open before attaching still surfaces it (and two boots can't race to delete it).
    expect(c.deleteCount()).toBe(0);
  });

  const sharedWs = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
  const putFiles = (socket: { sent: string[] }) => socket.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'putFile');

  // A page that hides its referrer can still POST a file to the share target, so a shared file is
  // only ever sent on the user's tap, never because a workspace was opened or came online.
  it('does not send a shared file when a workspace is opened or its machine comes online', async () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    store.statuses['mac'] = 'offline';
    const c = fakeCache(new Uint8Array([1, 2, 3]), 'shot.png');
    await store.loadSharedFile(c);
    store.open(sharedWs);
    store.setStatus('mac', 'online');
    expect(putFiles(sockets['wss://mac']!)).toEqual([]);
    expect(store.pendingSharedFile).not.toBeNull();
    expect(c.deleteCount()).toBe(0);
  });

  it('attaches the shared file to the open workspace on attachSharedFile, then drops the cache entry', async () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    store.statuses['mac'] = 'online';
    const c = fakeCache(new Uint8Array([1, 2, 3]), 'shot.png');
    await store.loadSharedFile(c);
    store.open(sharedWs);
    store.attachSharedFile();
    expect(putFiles(sockets['wss://mac']!)).toEqual([{ type: 'putFile', workspaceId: 'perch-a', name: 'shot.png', data: btoa(String.fromCharCode(1, 2, 3)) }]);
    expect(store.pendingSharedFile).toBeNull();
    expect(c.deleteCount()).toBe(1);
  });

  it('keeps the shared file when attachSharedFile runs while the machine is offline', async () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    store.statuses['mac'] = 'offline';
    const c = fakeCache(new Uint8Array([5]), 'shot.png');
    await store.loadSharedFile(c);
    store.open(sharedWs);
    store.attachSharedFile();
    expect(putFiles(sockets['wss://mac']!)).toEqual([]);
    expect(store.pendingSharedFile).not.toBeNull();
    expect(c.deleteCount()).toBe(0);
  });

  it('discards the shared file without sending it', async () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    store.statuses['mac'] = 'online';
    const c = fakeCache(new Uint8Array([5]), 'shot.png');
    await store.loadSharedFile(c);
    store.open(sharedWs);
    store.discardSharedFile();
    expect(putFiles(sockets['wss://mac']!)).toEqual([]);
    expect(store.pendingSharedFile).toBeNull();
    expect(c.deleteCount()).toBe(1);
  });

  // The cache entry is the only copy of a shared file, so a refused send must not consume it:
  // clearing on a no-op send would destroy the bytes and leave the user nothing to retry with.
  it('keeps an oversized shared file (and its cache entry) when the attach is refused', async () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    store.statuses['mac'] = 'online';
    const c = fakeCache(new Uint8Array(MAX_UPLOAD_BYTES + 1), 'huge.zip');
    await store.loadSharedFile(c);
    store.open(sharedWs);
    store.attachSharedFile();
    expect(putFiles(sockets['wss://mac']!)).toEqual([]);
    expect(store.actionError).toBe('File is too large to attach (20 MB max)');
    expect(store.pendingSharedFile).not.toBeNull();
    expect(c.deleteCount()).toBe(0);
  });

  it('loadSharedFile is a no-op when there is no cache', async () => {
    const { store } = build([mac]);
    store.start();
    await store.loadSharedFile(null);
    expect(store.pendingSharedFile).toBeNull();
  });

  it('marks the terminal moved on detached opened-elsewhere', () => {
    const { store } = build([mac]);
    store.start();
    const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
    store.open(ws);
    store.handleMessage('mac', { type: 'detached', workspaceId: 'perch-a', reason: 'opened-elsewhere' });
    expect(store.terminalState).toBe('moved');
  });

  it('takeOver flips back to live and re-attaches to reclaim the workspace', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
    store.open(ws);
    store.handleMessage('mac', { type: 'detached', workspaceId: 'perch-a', reason: 'opened-elsewhere' });
    expect(store.terminalState).toBe('moved');

    store.takeOver(80, 24);
    expect(store.terminalState).toBe('live');
    const attach = sockets['wss://mac']!.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'attach');
    expect(attach).toMatchObject({ type: 'attach', workspaceId: 'perch-a', cols: 80, rows: 24 });
  });

  it('records a connection error and clears it on online', () => {
    const { store } = build([mac]);
    store.setStatus('mac', 'offline');
    store.setConnectionError('mac', { message: 'connection failed (likely network error — relay unreachable)', code: 1006, at: 1000 });
    expect(store.lastConnectionError['mac']?.code).toBe(1006);
    store.setStatus('mac', 'online');
    expect(store.lastConnectionError['mac']).toBeUndefined();
  });

  it('updateMachine persists new url/token and reconnects via the manager', () => {
    const { store, sockets } = build([mac]);
    store.start();
    store.updateMachine('mac', { url: 'wss://mac-new', token: 't2' });
    expect(store.machines).toEqual([{ ...mac, url: 'wss://mac-new', token: 't2' }]);
    // setMachines reconnects with the new url → a socket for it now exists.
    expect(sockets['wss://mac-new']).toBeDefined();
  });

  it('updateMachine keeps the existing token when omitted', () => {
    const { store } = build([mac]);
    store.start();
    store.updateMachine('mac', { url: 'wss://mac-new' });
    expect(store.machines[0]).toEqual({ ...mac, url: 'wss://mac-new', token: 't' });
  });

  it('opens an existing workspace without auto-focusing the terminal', () => {
    const { store } = build([mac]);
    store.start();
    const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
    store.open(ws);
    expect(store.view).toBe('terminal');
    expect(store.autoFocus).toBe(false);
  });

  it('auto-opens the just-created workspace with the keyboard focused', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    // An existing workspace at the same path must NOT be mistaken for the new one.
    sockets['wss://mac']!.deliver({
      type: 'workspaces',
      workspaces: [
        { machineId: 'mac', id: 'perch-old', name: 'old', projectPath: '/p', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' },
      ],
    });
    store.requestCreate('mac', '/p', 'claude');
    expect(store.view).toBe('list');
    sockets['wss://mac']!.deliver({
      type: 'workspaces',
      workspaces: [
        { machineId: 'mac', id: 'perch-old', name: 'old', projectPath: '/p', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' },
        { machineId: 'mac', id: 'perch-new', name: 'new', projectPath: '/p', command: 'claude', createdAt: 1, lastActivityAt: 1, status: 'idle' },
      ],
    });
    expect(store.view).toBe('terminal');
    expect(store.active?.id).toBe('perch-new');
    expect(store.autoFocus).toBe(true);
  });

  it('stays on the create form and surfaces a create error, clearing the pending create', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    store.goCreate();
    store.requestCreate('mac', '/home/u/nope', 'claude');
    expect(store.view).toBe('create');
    sockets['wss://mac']!.deliver({
      type: 'error',
      code: 'internal',
      message: 'directory does not exist: /home/u/nope',
    });
    expect(store.createError).toBe('directory does not exist: /home/u/nope');
    expect(store.view).toBe('create');
    // A fresh attempt clears the stale error.
    store.requestCreate('mac', '/home/u/exists', 'claude');
    expect(store.createError).toBeNull();
  });

  it('cancelCreate returns to the workspace you came from, still attached', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
    store.open(ws);
    store.goCreate();
    expect(store.view).toBe('create');
    store.cancelCreate();
    expect(store.view).toBe('terminal');
    expect(store.active?.id).toBe('perch-a');
    // Backing out of the form must not tear down the attachment — the agent keeps
    // one attachment per connection and the terminal simply remounts.
    const sent = sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(sent).not.toContainEqual({ type: 'detach', workspaceId: 'perch-a' });
  });

  it('cancelCreate goes home when the form was opened from the list', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    store.goCreate();
    store.cancelCreate();
    expect(store.view).toBe('list');
    expect(store.active).toBeNull();
  });

  it('opens the created workspace even while still on the create form', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    store.goCreate();
    store.requestCreate('mac', '/p', 'claude');
    expect(store.view).toBe('create');
    sockets['wss://mac']!.deliver({
      type: 'workspaces',
      workspaces: [
        { machineId: 'mac', id: 'perch-new', name: 'new', projectPath: '/p', command: 'claude', createdAt: 1, lastActivityAt: 1, status: 'idle' },
      ],
    });
    expect(store.view).toBe('terminal');
    expect(store.active?.id).toBe('perch-new');
  });

  it('focuses the keyboard anchor on create, while the tap gesture is live', () => {
    const { store } = build([mac]);
    store.start();
    let focused = 0;
    store.setKeyboardAnchor(() => (focused += 1));
    store.requestCreate('mac', '/p', 'claude');
    expect(focused).toBe(1);
  });

  it('records the last used machine on create', () => {
    const { store } = build([mac]);
    store.start();
    expect(store.lastMachineId).toBeNull();
    store.requestCreate('mac', '/p', 'claude');
    expect(store.lastMachineId).toBe('mac');
  });

  it('records the last used command on create', () => {
    const storage = memStorage([mac]);
    const settings = new SettingsStore(storage);
    const aggregator = new WorkspaceAggregator();
    const manager = new ConnectionManager({
      secureSocketFactory: () => () => ({ send: () => undefined, close: () => undefined, onMessage: () => undefined, onOpen: () => undefined, onClose: () => undefined }),
      aggregator,
      onMessage: () => undefined,
      onStatus: () => undefined,
      schedule: () => undefined,
    });
    const store = new PerchStore({ settings, manager, aggregator, ...prompts });
    store.start();
    expect(store.lastCommand).toBeNull();
    store.requestCreate('mac', '/p', 'codex');
    expect(store.lastCommand).toBe('codex');
    expect(new SettingsStore(storage).lastCommand()).toBe('codex');
  });

  it('loads the last used command on start', () => {
    const storage = memStorage([mac]);
    new SettingsStore(storage).setLastCommand('zsh');
    const settings = new SettingsStore(storage);
    const aggregator = new WorkspaceAggregator();
    const manager = new ConnectionManager({
      secureSocketFactory: () => () => ({ send: () => undefined, close: () => undefined, onMessage: () => undefined, onOpen: () => undefined, onClose: () => undefined }),
      aggregator,
      onMessage: () => undefined,
      onStatus: () => undefined,
      schedule: () => undefined,
    });
    const store = new PerchStore({ settings, manager, aggregator, ...prompts });
    store.start();
    expect(store.lastCommand).toBe('zsh');
  });

  it('closeActive sends only close, no detach', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
    store.open(ws);
    const sentBeforeClose = sockets['wss://mac']!.sent.length;
    store.closeActive();
    const sentAfterClose = sockets['wss://mac']!.sent.slice(sentBeforeClose);
    const parsed = sentAfterClose.map((s) => JSON.parse(s));
    expect(parsed).toContainEqual({ type: 'close', workspaceId: 'perch-a' });
    expect(parsed.some((m: unknown) => typeof m === 'object' && m !== null && (m as Record<string, unknown>).type === 'detach')).toBe(false);
  });

  it('toggleMachine disables a machine and persists the flag', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    store.toggleMachine('mac');
    expect(store.machines[0]?.enabled).toBe(false);
  });

  it('toggleMachine re-enables a disabled machine and reconnects', () => {
    const { store, sockets } = build([{ ...mac, enabled: false }]);
    store.start();
    expect(sockets['wss://mac']).toBeUndefined();
    store.toggleMachine('mac');
    expect(store.machines[0]?.enabled).toBe(true);
    expect(sockets['wss://mac']).toBeDefined();
  });
});

describe('PerchStore file browser', () => {
  function openWorkspace() {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/home/u/proj', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
    store.open(ws);
    return { store, sockets, ws };
  }

  it('openBrowser confines to the project path and requests its entries', () => {
    const { store, sockets } = openWorkspace();
    store.openBrowser();
    expect(store.view).toBe('browser');
    expect(store.browserRoot).toBe('/home/u/proj');
    const parsed = sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(parsed).toContainEqual({ type: 'browseDir', path: '/home/u/proj' });
  });

  it('keeps the active workspace while browsing (no detach)', () => {
    const { store, sockets } = openWorkspace();
    store.openBrowser();
    const parsed = sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(parsed.some((m) => m.type === 'detach')).toBe(false);
    expect(store.active?.id).toBe('perch-a');
  });

  it('browseInto requests a subdirectory on the active machine', () => {
    const { store, sockets } = openWorkspace();
    store.openBrowser();
    store.browseInto('/home/u/proj/src');
    const parsed = sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(parsed).toContainEqual({ type: 'browseDir', path: '/home/u/proj/src' });
  });

  it('stores dirEntries with files from the agent', () => {
    const { store } = openWorkspace();
    store.openBrowser();
    store.handleMessage('mac', { type: 'dirEntries', path: '/home/u/proj', subdirs: ['/home/u/proj/src'], files: ['/home/u/proj/README.md'] });
    expect(store.dirEntries).toEqual({ path: '/home/u/proj', subdirs: ['/home/u/proj/src'], files: ['/home/u/proj/README.md'] });
  });

  it('closeBrowser returns to the terminal without clearing active', () => {
    const { store } = openWorkspace();
    store.openBrowser();
    store.closeBrowser();
    expect(store.view).toBe('terminal');
    expect(store.active?.id).toBe('perch-a');
  });

  it('surfaces an agent error while browsing instead of hanging', () => {
    const { store } = openWorkspace();
    store.openBrowser();
    store.handleMessage('mac', { type: 'error', code: 'internal', message: 'path outside allowed roots: /x' });
    expect(store.browseError).toBe('path outside allowed roots: /x');
  });

  it('clears a prior browse error when entries arrive', () => {
    const { store } = openWorkspace();
    store.openBrowser();
    store.handleMessage('mac', { type: 'error', code: 'internal', message: 'boom' });
    store.handleMessage('mac', { type: 'dirEntries', path: '/home/u/proj', subdirs: [], files: [] });
    expect(store.browseError).toBeNull();
  });

  it('ignores agent errors when not browsing', () => {
    const { store } = openWorkspace();
    store.handleMessage('mac', { type: 'error', code: 'internal', message: 'unrelated' });
    expect(store.browseError).toBeNull();
  });

  // Without this, an agent refusal (e.g. parking a workspace with no resumable Claude
  // session) is dropped on the floor and the action silently appears to do nothing.
  it('surfaces an agent error with no owning view as an action error', () => {
    const { store } = openWorkspace();
    store.handleMessage('mac', {
      type: 'error',
      code: 'not-restorable',
      message: 'cannot park: no Claude session to resume',
    });
    expect(store.actionError).toBe('cannot park: no Claude session to resume');
  });

  it('dismisses an action error', () => {
    const { store } = openWorkspace();
    store.handleMessage('mac', { type: 'error', code: 'not-restorable', message: 'nope' });
    store.dismissActionError();
    expect(store.actionError).toBeNull();
  });

  it('never surfaces bad_message as an action error', () => {
    const { store } = openWorkspace();
    store.handleMessage('mac', { type: 'error', code: 'bad_message', message: 'protocol noise' });
    expect(store.actionError).toBeNull();
  });

  it('ignores a bad_message protocol error (version-skew heartbeat) without surfacing it', () => {
    // An agent that predates `ping` answers it with a bad_message error. That's harmless
    // protocol noise, not a failed user action, so it must not pop up in an open view.
    const { store } = openWorkspace();
    store.openBrowser();
    store.handleMessage('mac', { type: 'error', code: 'bad_message', message: 'Invalid input' });
    expect(store.browseError).toBeNull();
  });
});

describe('PerchStore folder picker', () => {
  function connected() {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    return { store, sockets };
  }

  it('goCreate asks each machine for its project roots', () => {
    const { store, sockets } = connected();
    store.goCreate();
    const parsed = sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(parsed).toContainEqual({ type: 'listRoots' });
  });

  // Opening the form while the machine is still connecting must not leave Browse disabled for good.
  it('asks a machine that comes online while the create form is open for its roots and recent paths', () => {
    const { store, sockets } = build([mac]);
    store.start();
    store.goCreate();
    // The real socket drops what is sent before its session is up.
    sockets['wss://mac']!.sent.length = 0;
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    // What main.ts wires the manager's status to; this harness only records it.
    store.setStatus('mac', 'online');
    const parsed = sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(parsed).toContainEqual({ type: 'listRoots' });
    expect(parsed).toContainEqual({ type: 'getRecentPaths' });
  });

  it('goNewMachine switches to the newMachine view', () => {
    const { store } = build();
    store.goNewMachine();
    expect(store.view).toBe('newMachine');
  });

  it('stores the roots a machine reports', () => {
    const { store } = connected();
    store.handleMessage('mac', { type: 'roots', roots: ['/home/u/workspace', '/srv/code'] });
    expect(store.machineRoots['mac']).toEqual(['/home/u/workspace', '/srv/code']);
  });

  it('stores the launchers a machine reports, per machine', () => {
    const { store } = connected();
    store.handleMessage('mac', { type: 'launchers', detected: ['claude'], custom: ['pi'] });
    expect(store.machineLaunchers['mac']).toEqual({ detected: ['claude'], custom: ['pi'] });
    expect(store.machineLaunchers['mini']).toBeUndefined();
  });

  it('asks for the launchers when the create form opens', () => {
    const { store, sockets } = connected();
    store.goCreate();
    const sent = sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(sent).toContainEqual({ type: 'listLaunchers' });
  });

  it('sends remember only when asked, and forgetLauncher on request', () => {
    const { store, sockets } = connected();
    store.requestCreate('mac', '/p', 'pi', true);
    store.forgetLauncher('mac', 'pi');
    const sent = sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(sent).toContainEqual({ type: 'create', projectPath: '/p', command: 'pi', remember: true });
    expect(sent).toContainEqual({ type: 'forgetLauncher', command: 'pi' });
    store.requestCreate('mac', '/p', 'claude');
    const last = sockets['wss://mac']!.sent.map((s) => JSON.parse(s)).at(-1);
    expect(last).toEqual({ type: 'create', projectPath: '/p', command: 'claude' });
  });

  it('stores the command shortcuts a machine reports', () => {
    const { store } = connected();
    store.handleMessage('mac', {
      type: 'commands',
      commands: [
        { command: '/myplugin:task', submit: false },
        { command: '/rename', submit: true },
      ],
    });
    expect(store.machineCommands['mac']).toEqual([
      { command: '/myplugin:task', submit: false },
      { command: '/rename', submit: true },
    ]);
  });

  const withKills = (oomKills: number | undefined) => ({
    cpuPercent: 12,
    memory: { usedBytes: 100, totalBytes: 400 },
    swapUsedBytes: 0,
    limit: { usedBytes: 90, totalBytes: 100, stallPercent: 0, ...(oomKills !== undefined && { oomKills }) },
  });

  it('stores the load a machine reports, keyed by connection id', () => {
    const { store } = connected();
    const stats = {
      cpuPercent: 12,
      memory: { usedBytes: 100, totalBytes: 400 },
      swapUsedBytes: 0,
      limit: { usedBytes: 90, totalBytes: 100, stallPercent: 0 },
    };
    store.handleMessage('mac', { type: 'stats', stats });
    expect(store.machineStats['mac']).toEqual(stats);
    expect(store.machineStats['mini']).toBeUndefined();
  });

  // A reading is only true for the moment it was taken. Keeping the last one after the
  // socket dies would show a minutes-old load as if it were current.
  it('drops a machine load reading when that machine goes offline', () => {
    const { store } = connected();
    const stats = { cpuPercent: 12, memory: { usedBytes: 100, totalBytes: 400 }, swapUsedBytes: 0 };
    store.handleMessage('mac', { type: 'stats', stats });
    store.handleMessage('mini', { type: 'stats', stats });
    store.setStatus('mac', 'offline');
    expect(store.machineStats['mac']).toBeUndefined();
    expect(store.machineStats['mini']).toEqual(stats);
  });

  // The kill counter is cumulative for the life of the cgroup, so its absolute value says
  // nothing. Only growth since this client started watching means a kill the user just had.
  it('reports no kills from the first reading it sees, however high the counter', () => {
    const { store } = connected();
    store.handleMessage('mac', { type: 'stats', stats: withKills(7) });
    expect(store.oomKillsSince('mac')).toBe(0);
  });

  it('reports the growth in the kill counter since the first reading', () => {
    const { store } = connected();
    store.handleMessage('mac', { type: 'stats', stats: withKills(7) });
    store.handleMessage('mac', { type: 'stats', stats: withKills(9) });
    expect(store.oomKillsSince('mac')).toBe(2);
  });

  // A kill that lands while the phone is backgrounded is exactly the one worth surfacing, so
  // the baseline must outlive the socket even though the reading itself does not.
  it('keeps counting across a reconnect', () => {
    const { store } = connected();
    store.handleMessage('mac', { type: 'stats', stats: withKills(7) });
    store.setStatus('mac', 'offline');
    store.setStatus('mac', 'online');
    store.handleMessage('mac', { type: 'stats', stats: withKills(8) });
    expect(store.oomKillsSince('mac')).toBe(1);
  });

  // The counter lives in the cgroup; if that is recreated it restarts at zero, and a
  // negative delta would otherwise read as a permanent all-clear.
  it('re-baselines when the counter goes backwards', () => {
    const { store } = connected();
    store.handleMessage('mac', { type: 'stats', stats: withKills(7) });
    store.handleMessage('mac', { type: 'stats', stats: withKills(1) });
    expect(store.oomKillsSince('mac')).toBe(0);
  });

  it('reports no kills for a machine that never sent a counter', () => {
    const { store } = connected();
    store.handleMessage('mac', { type: 'stats', stats: withKills(undefined) });
    expect(store.oomKillsSince('mac')).toBe(0);
    expect(store.oomKillsSince('mini')).toBe(0);
  });

  // Keyed by connection id, so two machines' drop-downs never bleed into each other.
  it('keeps each machine command shortcuts separate', () => {
    const { store } = connected();
    store.handleMessage('mac', { type: 'commands', commands: [{ command: '/mac-only', submit: false }] });
    store.handleMessage('mini', { type: 'commands', commands: [{ command: '/mini-only', submit: true }] });
    expect(store.machineCommands['mac']).toEqual([{ command: '/mac-only', submit: false }]);
    expect(store.machineCommands['mini']).toEqual([{ command: '/mini-only', submit: true }]);
  });

  it('stores the dictation vocabulary a machine reports', () => {
    const { store } = connected();
    store.handleMessage('mac', { type: 'keyterms', keyterms: ['Perch', 'HeliBoard'] });
    expect(store.machineKeyterms['mac']).toEqual(['Perch', 'HeliBoard']);
  });

  // Every machine links the same dotfiles vocabulary, so the union is what goes to the API.
  it('unions the machines vocabularies for a dictation request, without duplicates', () => {
    const { store } = connected();
    store.handleMessage('mac', { type: 'keyterms', keyterms: ['Perch', 'worktree'] });
    store.handleMessage('mini', { type: 'keyterms', keyterms: ['perch', 'tmux'] });
    expect(store.keyterms()).toEqual(['Perch', 'worktree', 'tmux']);
  });

  it('has an empty vocabulary before any machine replies', () => {
    const { store } = connected();
    expect(store.keyterms()).toEqual([]);
  });

  it('openFolderPicker marks the picker active and clears stale entries', () => {
    const { store } = connected();
    store.dirEntries = { path: '/x', subdirs: [], files: [] };
    store.browseError = 'old';
    store.openFolderPicker();
    expect(store.pickerActive).toBe(true);
    expect(store.dirEntries).toBeNull();
    expect(store.browseError).toBeNull();
  });

  it('pickerBrowse requests a directory on the chosen machine', () => {
    const { store, sockets } = connected();
    store.openFolderPicker();
    store.pickerBrowse('mac', '/home/u/workspace/perch');
    const parsed = sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(parsed).toContainEqual({ type: 'browseDir', path: '/home/u/workspace/perch' });
  });

  it('pickerMakeDir asks the agent to create a folder in the chosen parent', () => {
    const { store, sockets } = connected();
    store.openFolderPicker();
    store.pickerMakeDir('mac', '/home/u/workspace', 'new-folder');
    const parsed = sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(parsed).toContainEqual({ type: 'makeDir', parent: '/home/u/workspace', name: 'new-folder' });
  });

  it('stores dirEntries from the agent while picking', () => {
    const { store } = connected();
    store.openFolderPicker();
    store.pickerBrowse('mac', '/home/u/workspace');
    store.handleMessage('mac', { type: 'dirEntries', path: '/home/u/workspace', subdirs: ['/home/u/workspace/perch'], files: [] });
    expect(store.dirEntries).toEqual({ path: '/home/u/workspace', subdirs: ['/home/u/workspace/perch'], files: [] });
  });

  it('surfaces an agent error while picking instead of hanging', () => {
    const { store } = connected();
    store.openFolderPicker();
    store.pickerBrowse('mac', '/outside');
    store.handleMessage('mac', { type: 'error', code: 'internal', message: 'path outside allowed roots: /outside' });
    expect(store.browseError).toBe('path outside allowed roots: /outside');
    expect(store.viewError).toBeNull();
  });

  it('closeFolderPicker clears the active flag', () => {
    const { store } = connected();
    store.openFolderPicker();
    store.closeFolderPicker();
    expect(store.pickerActive).toBe(false);
  });

  it('does not treat agent errors as a browse failure once the picker is closed', () => {
    const { store } = connected();
    store.openFolderPicker();
    store.closeFolderPicker();
    store.handleMessage('mac', { type: 'error', code: 'internal', message: 'unrelated' });
    expect(store.browseError).toBeNull();
  });
});

describe('PerchStore file viewer', () => {
  function openWorkspace() {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    store.setStatus('mac', 'online');
    const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/home/u/proj', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
    store.open(ws);
    return { store, sockets, ws };
  }

  // Answers the pending in-session media read the way the agent does.
  function answerMedia(sockets: ReturnType<typeof build>['sockets'], result: string, bytes?: Uint8Array) {
    const sent = sockets['wss://mac']!.sent.map((m) => JSON.parse(m) as { type: string; id?: string; path?: string });
    const request = sent.filter((m) => m.type === 'readMedia').at(-1)!;
    const deliver = sockets['wss://mac']!.deliver;
    if (!bytes) {
      deliver({ type: 'media', id: request.id, result });
      return request;
    }
    const path = request.path ?? '';
    const mediaType = imageMediaType(path) || pdfMediaType(path) || audioMediaType(path);
    deliver({ type: 'media', id: request.id, result, mediaType, size: bytes.length });
    deliver({ type: 'mediaChunk', id: request.id, seq: 0, data: Buffer.from(bytes).toString('base64') });
    return request;
  }

  it('openFile requests the file and switches to the viewer', () => {
    const { store, sockets } = openWorkspace();
    store.openFile('/home/u/proj/a.txt');
    expect(store.view).toBe('viewer');
    const parsed = sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(parsed).toContainEqual({ type: 'readFile', path: '/home/u/proj/a.txt' });
  });

  it('showImageNeighbor opens the next/previous image and reports position', () => {
    const { store } = openWorkspace();
    store.dirEntries = {
      path: '/home/u/proj',
      subdirs: [],
      files: ['/home/u/proj/README.md', '/home/u/proj/a.png', '/home/u/proj/b.png'],
    };
    store.openFile('/home/u/proj/a.png');
    expect(store.imagePosition).toEqual({ index: 1, count: 2 });

    store.showImageNeighbor(1);
    expect(store.fileView?.path).toBe('/home/u/proj/b.png');
    expect(store.imagePosition).toEqual({ index: 2, count: 2 });

    store.showImageNeighbor(1); // at the end → no-op
    expect(store.fileView?.path).toBe('/home/u/proj/b.png');
  });

  it('showAudioNeighbor opens the next/previous audio by filename and reports position', () => {
    const { store } = openWorkspace();
    store.dirEntries = {
      path: '/home/u/proj',
      subdirs: [],
      files: ['/home/u/proj/README.md', '/home/u/proj/track10.mp3', '/home/u/proj/track2.mp3'],
    };
    // Ordered by filename: track2 before track10.
    store.openFile('/home/u/proj/track2.mp3');
    expect(store.audioPosition).toEqual({ index: 1, count: 2 });

    store.showAudioNeighbor(1);
    expect(store.fileView?.path).toBe('/home/u/proj/track10.mp3');
    expect(store.audioPosition).toEqual({ index: 2, count: 2 });

    store.showAudioNeighbor(-1);
    expect(store.fileView?.path).toBe('/home/u/proj/track2.mp3');

    store.showAudioNeighbor(-1); // at the start → no-op
    expect(store.fileView?.path).toBe('/home/u/proj/track2.mp3');
  });

  it('showAudioNeighbor is a no-op without dirEntries', () => {
    const { store } = openWorkspace();
    store.openFile('/home/u/proj/track2.mp3');
    store.showAudioNeighbor(1);
    expect(store.fileView?.path).toBe('/home/u/proj/track2.mp3');
    expect(store.audioPosition).toBeNull();
  });

  it('showImageNeighbor is a no-op without dirEntries', () => {
    const { store } = openWorkspace();
    store.openFile('/home/u/proj/a.png');
    store.showImageNeighbor(1);
    expect(store.fileView?.path).toBe('/home/u/proj/a.png');
    expect(store.imagePosition).toBeNull();
  });

  it('decodes fileContents to UTF-8 text (no mojibake)', () => {
    const { store } = openWorkspace();
    store.openFile('/home/u/proj/a.txt');
    const data = Buffer.from('café ✓\n', 'utf8').toString('base64');
    store.handleMessage('mac', { type: 'fileContents', path: '/home/u/proj/a.txt', data, truncated: false, binary: false });
    expect(store.fileView).toEqual({ path: '/home/u/proj/a.txt', text: 'café ✓\n', mediaType: '', blobUrl: '', truncated: false, binary: false });
  });

  it('marks a binary fileContents with empty text', () => {
    const { store } = openWorkspace();
    store.openFile('/home/u/proj/blob.bin');
    store.handleMessage('mac', { type: 'fileContents', path: '/home/u/proj/blob.bin', data: '', truncated: false, binary: true });
    expect(store.fileView?.binary).toBe(true);
    expect(store.fileView?.text).toBe('');
  });

  it('passes the truncated flag through', () => {
    const { store } = openWorkspace();
    store.openFile('/home/u/proj/big.log');
    const data = Buffer.from('partial', 'utf8').toString('base64');
    store.handleMessage('mac', { type: 'fileContents', path: '/home/u/proj/big.log', data, truncated: true, binary: false });
    expect(store.fileView?.truncated).toBe(true);
  });

  it('opens an image inside the session and exposes a blob object URL', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();
    const { store, sockets } = openWorkspace();

    store.openFile('/home/u/proj/a.png');
    // Synchronously enters the viewer as an image, before the bytes arrive.
    expect(store.view).toBe('viewer');
    expect(store.fileView).toMatchObject({ path: '/home/u/proj/a.png', mediaType: 'image/png', blobUrl: '' });
    // Media bytes never ride readFile.
    expect(sockets['wss://mac']!.sent.map((s) => JSON.parse(s)).some((m) => m.type === 'readFile')).toBe(false);

    expect(answerMedia(sockets, 'ok', new Uint8Array([1, 2, 3]))).toMatchObject({ path: '/home/u/proj/a.png' });
    await vi.waitFor(() => expect(store.fileView?.blobUrl).toBe('blob:fake'));
  });

  it('marks an over-cap image truncated with no url', async () => {
    const { store, sockets } = openWorkspace();
    store.openFile('/home/u/proj/big.jpg');
    answerMedia(sockets, 'too-large');
    await vi.waitFor(() => expect(store.fileView?.truncated).toBe(true));
    expect(store.fileView?.blobUrl).toBe('');
  });

  it('opens a pdf inside the session and exposes a blob object URL (no readFile)', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:pdf');
    URL.revokeObjectURL = vi.fn();
    const { store, sockets } = openWorkspace();

    store.openFile('/home/u/proj/doc.pdf');
    expect(store.view).toBe('viewer');
    expect(store.fileView).toMatchObject({ path: '/home/u/proj/doc.pdf', mediaType: 'application/pdf', blobUrl: '' });
    expect(sockets['wss://mac']!.sent.map((s) => JSON.parse(s)).some((m) => m.type === 'readFile')).toBe(false);

    expect(answerMedia(sockets, 'ok', new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toMatchObject({ path: '/home/u/proj/doc.pdf' });
    await vi.waitFor(() => expect(store.fileView?.blobUrl).toBe('blob:pdf'));
  });

  it('opens an audio file inside the session and exposes a blob object URL (no readFile)', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:audio');
    URL.revokeObjectURL = vi.fn();
    const { store, sockets } = openWorkspace();

    store.openFile('/home/u/proj/clip.mp3');
    expect(store.view).toBe('viewer');
    expect(store.fileView).toMatchObject({ path: '/home/u/proj/clip.mp3', mediaType: 'audio/mpeg', blobUrl: '' });
    expect(sockets['wss://mac']!.sent.map((s) => JSON.parse(s)).some((m) => m.type === 'readFile')).toBe(false);

    expect(answerMedia(sockets, 'ok', new Uint8Array([0x49, 0x44, 0x33]))).toMatchObject({ path: '/home/u/proj/clip.mp3' });
    await vi.waitFor(() => expect(store.fileView?.blobUrl).toBe('blob:audio'));
  });

  it('marks an over-cap pdf truncated with no url', async () => {
    const { store, sockets } = openWorkspace();
    store.openFile('/home/u/proj/big.pdf');
    answerMedia(sockets, 'too-large');
    await vi.waitFor(() => expect(store.fileView?.truncated).toBe(true));
    expect(store.fileView?.blobUrl).toBe('');
  });

  it('sets viewError when the agent fails the read', async () => {
    const { store, sockets } = openWorkspace();
    store.openFile('/home/u/proj/a.png');
    answerMedia(sockets, 'error');
    await vi.waitFor(() => expect(store.viewError).toBe("Couldn't load this file: the agent could not read it."));
  });

  it('sets viewError when the machine drops mid-read', async () => {
    const { store } = openWorkspace();
    store.openFile('/home/u/proj/a.png');
    store.setStatus('mac', 'offline');
    await vi.waitFor(() => expect(store.viewError).toBe("Couldn't load this file."));
  });

  it('surfaces an agent error while viewing instead of hanging', () => {
    const { store } = openWorkspace();
    store.openFile('/home/u/proj/a.txt');
    store.handleMessage('mac', { type: 'error', code: 'internal', message: 'denied' });
    expect(store.viewError).toBe('denied');
  });

  it('closeViewer returns to the browser', () => {
    const { store } = openWorkspace();
    store.openFile('/home/u/proj/a.txt');
    store.closeViewer();
    expect(store.view).toBe('browser');
  });

  it('loads the wrap preference on start (defaults on)', () => {
    const { store } = build([mac]);
    store.start();
    expect(store.fileWrap).toBe(true);
  });

  it('setFileWrap updates state and persists across a reload', () => {
    const storage = memStorage([mac]);
    const settings = new SettingsStore(storage);
    const aggregator = new WorkspaceAggregator();
    const manager = new ConnectionManager({
      secureSocketFactory: () => () => ({ send: () => undefined, close: () => undefined, onMessage: () => undefined, onOpen: () => undefined, onClose: () => undefined }),
      aggregator,
      onMessage: () => undefined,
      onStatus: () => undefined,
      schedule: () => undefined,
    });
    const store = new PerchStore({ settings, manager, aggregator, ...prompts });
    store.start();
    store.setFileWrap(false);
    expect(store.fileWrap).toBe(false);
    expect(new SettingsStore(storage).fileWrap()).toBe(false);
  });

  it('loads the folder filter on start (defaults to empty)', () => {
    const { store } = build([mac]);
    store.start();
    expect(store.folderFilter).toEqual([]);
  });

  it('setFolderFilter updates state and persists across a reload', () => {
    const storage = memStorage([mac]);
    const settings = new SettingsStore(storage);
    const aggregator = new WorkspaceAggregator();
    const manager = new ConnectionManager({
      secureSocketFactory: () => () => ({ send: () => undefined, close: () => undefined, onMessage: () => undefined, onOpen: () => undefined, onClose: () => undefined }),
      aggregator,
      onMessage: () => undefined,
      onStatus: () => undefined,
      schedule: () => undefined,
    });
    const store = new PerchStore({ settings, manager, aggregator, ...prompts });
    store.start();
    store.setFolderFilter(['api']);
    expect(store.folderFilter).toEqual(['api']);
    expect(new SettingsStore(storage).folderFilter()).toEqual(['api']);
  });

  it('loads the hidden folders and filter mode on start (defaults to empty / show-only)', () => {
    const { store } = build([mac]);
    store.start();
    expect(store.folderHidden).toEqual([]);
    expect(store.folderFilterMode).toBe('only');
  });

  it('setFolderHidden and setFolderFilterMode update state and persist across a reload', () => {
    const storage = memStorage([mac]);
    const settings = new SettingsStore(storage);
    const aggregator = new WorkspaceAggregator();
    const manager = new ConnectionManager({
      secureSocketFactory: () => () => ({ send: () => undefined, close: () => undefined, onMessage: () => undefined, onOpen: () => undefined, onClose: () => undefined }),
      aggregator,
      onMessage: () => undefined,
      onStatus: () => undefined,
      schedule: () => undefined,
    });
    const store = new PerchStore({ settings, manager, aggregator, ...prompts });
    store.start();
    store.setFolderHidden(['acme']);
    store.setFolderFilterMode('hide');
    expect(store.folderHidden).toEqual(['acme']);
    expect(store.folderFilterMode).toBe('hide');
    const reloaded = new SettingsStore(storage);
    expect(reloaded.folderHidden()).toEqual(['acme']);
    expect(reloaded.folderFilterMode()).toBe('hide');
  });

  it('loads the terminal font size on start (defaults to 13)', () => {
    const { store } = build([mac]);
    store.start();
    expect(store.terminalFontSize).toBe(13);
  });

  it('setTerminalFontSize updates state, persists, and clamps to bounds', () => {
    const storage = memStorage([mac]);
    const settings = new SettingsStore(storage);
    const aggregator = new WorkspaceAggregator();
    const manager = new ConnectionManager({
      secureSocketFactory: () => () => ({ send: () => undefined, close: () => undefined, onMessage: () => undefined, onOpen: () => undefined, onClose: () => undefined }),
      aggregator,
      onMessage: () => undefined,
      onStatus: () => undefined,
      schedule: () => undefined,
    });
    const store = new PerchStore({ settings, manager, aggregator, ...prompts });
    store.start();
    store.setTerminalFontSize(18);
    expect(store.terminalFontSize).toBe(18);
    expect(new SettingsStore(storage).terminalFontSize()).toBe(18);
    store.setTerminalFontSize(100);
    expect(store.terminalFontSize).toBe(24);
    store.setTerminalFontSize(2);
    expect(store.terminalFontSize).toBe(8);
  });
});

describe('PerchStore dictation', () => {
  function build(transcript: string, transcriber: { transcribe: () => Promise<string> } = { transcribe: () => Promise.resolve(transcript) }) {
    const sent: string[] = [];
    const aggregator = new WorkspaceAggregator();
    const settings = new SettingsStore(memStorage([mac]));
    const manager = new ConnectionManager({
      secureSocketFactory: () => () => ({
        send: (d) => void sent.push(d),
        close: () => undefined,
        onMessage: () => undefined,
        onOpen: () => undefined,
        onClose: () => undefined,
      }),
      aggregator,
      onMessage: () => undefined,
      onStatus: () => undefined,
      schedule: () => undefined,
    });
    const recorder = {
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(new Blob(['x'], { type: 'audio/webm' })),
    };
    const store = new PerchStore({ settings, manager, aggregator, recorder, transcriber, ...prompts });
    store.start();
    const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
    store.open(ws);
    return { store, sent };
  }

  it('starts idle', () => {
    expect(build('').store.dictationState).toBe('idle');
  });

  it('records on the first toggle and inserts the transcript on the second', async () => {
    const { store, sent } = build('hello there');
    await store.toggleDictation();
    expect(store.dictationState).toBe('recording');
    await store.toggleDictation();
    expect(store.dictationState).toBe('idle');
    const parsed = sent.map((s) => JSON.parse(s));
    expect(parsed).toContainEqual({
      type: 'input',
      workspaceId: 'perch-a',
      data: Buffer.from('hello there', 'utf8').toString('base64'),
    });
  });

  it('tells the view before inserting a transcript', async () => {
    const { store } = build('hello there');
    let injected = 0;
    store.onInjectedInput = () => injected++;
    await store.toggleDictation();
    await store.toggleDictation();
    expect(injected).toBe(1);
  });

  it('does not insert an empty transcript', async () => {
    const { store, sent } = build('  ');
    await store.toggleDictation();
    await store.toggleDictation();
    const parsed = sent.map((s) => JSON.parse(s));
    expect(parsed.some((m) => m.type === 'input')).toBe(false);
  });

  it('surfaces a failed transcription and clears it on dismiss', async () => {
    const { store } = build('', { transcribe: () => Promise.reject(new Error('ElevenLabs quota exceeded')) });
    await store.toggleDictation();
    await store.toggleDictation();
    expect(store.dictationState).toBe('error');
    expect(store.dictationError).toBe('ElevenLabs quota exceeded');
    store.dismissDictationError();
    expect(store.dictationState).toBe('idle');
    expect(store.dictationError).toBeNull();
  });
});

describe('PerchStore update banner', () => {
  it('starts with no update pending', () => {
    const { store } = build();
    expect(store.updateReady).toBe(false);
    expect(store.incomingBuildLabel).toBeNull();
  });

  it('notifyUpdateAvailable surfaces the incoming label', () => {
    const { store } = build();
    store.notifyUpdateAvailable('feat-x');
    expect(store.updateReady).toBe(true);
    expect(store.incomingBuildLabel).toBe('feat-x');
  });

  it('applyUpdate invokes the injected updater', () => {
    let applied = 0;
    const { store } = build([], () => { applied += 1; });
    store.applyUpdate();
    expect(applied).toBe(1);
  });

  it('dismissUpdate hides the banner without applying', () => {
    let applied = 0;
    const { store } = build([], () => { applied += 1; });
    store.notifyUpdateAvailable('feat-x');
    store.dismissUpdate();
    expect(store.updateReady).toBe(false);
    expect(applied).toBe(0);
  });

  it('re-shows the banner when a later update is detected after dismiss', () => {
    const { store } = build();
    store.notifyUpdateAvailable('feat-x');
    store.dismissUpdate();
    store.notifyUpdateAvailable('feat-y');
    expect(store.updateReady).toBe(true);
    expect(store.incomingBuildLabel).toBe('feat-y');
  });

  it('setWorkspaceStatus sends setStatus for the active workspace and reflects the synced status', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
    store.open(ws);

    store.setWorkspaceStatus('blocked');
    const sent = () => sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(sent()).toContainEqual({ type: 'setStatus', workspaceId: 'perch-a', status: 'blocked' });

    // The agent echoes the synced workspace; the active view must reflect the new status so
    // the header picker shows it.
    sockets['wss://mac']!.deliver({ type: 'workspaceUpdated', workspace: { ...ws, status: 'blocked' } });
    expect(store.active?.status).toBe('blocked');
  });

  it('setWorkspaceUrgent sends setUrgent for the active workspace and reflects the synced flag', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
    store.open(ws);

    store.setWorkspaceUrgent(true);
    const sent = () => sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(sent()).toContainEqual({ type: 'setUrgent', workspaceId: 'perch-a', urgent: true });

    // The agent echoes the synced workspace; the active view must reflect the pin so the
    // drawer toggle shows it as on.
    sockets['wss://mac']!.deliver({ type: 'workspaceUpdated', workspace: { ...ws, urgent: true } });
    expect(store.active?.urgent).toBe(true);
  });

  const openWs = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };

  it('re-attaches the active terminal after its machine drops and reconnects', () => {
    const { store } = build([mac]);
    store.start();
    store.open(openWs);
    let reattached = 0;
    store.onReattach = () => (reattached += 1);
    store.setStatus('mac', 'offline');
    store.setStatus('mac', 'connecting');
    store.setStatus('mac', 'online');
    expect(reattached).toBe(1);
  });

  it('does not re-attach when a machine first reaches online (no prior drop)', () => {
    const { store } = build([mac]);
    store.start();
    store.open(openWs);
    let reattached = 0;
    store.onReattach = () => (reattached += 1);
    store.setStatus('mac', 'connecting');
    store.setStatus('mac', 'online');
    expect(reattached).toBe(0);
  });

  it('does not re-attach when the recovered machine is not the active one', () => {
    const { store } = build([mac]);
    store.start();
    store.open(openWs);
    let reattached = 0;
    store.onReattach = () => (reattached += 1);
    store.setStatus('other', 'offline');
    store.setStatus('other', 'online');
    expect(reattached).toBe(0);
  });

  it('checkActiveLiveness probes the active machine connection', () => {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    store.open(openWs);
    store.checkActiveLiveness();
    const sent = sockets['wss://mac']!.sent.map((s) => JSON.parse(s));
    expect(sent).toContainEqual({ type: 'ping' });
  });
});

describe('PerchStore browser view', () => {
  function connected() {
    const { store, sockets } = build([mac]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mac']!.deliver({ type: 'authResult', ok: true });
    return { store, sockets };
  }

  it('stores browser sessions under the connection id despite a mismatched agent machineId', () => {
    const { store, sockets } = connected();
    // The agent self-reports a different machine id; routing must key on the connection id.
    sockets['wss://mac']!.deliver({
      type: 'workspaces',
      workspaces: [
        { machineId: 'agent-mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' },
      ],
    });
    sockets['wss://mac']!.deliver({ type: 'browserSessions', sessions: [{ name: 'perch-a' }, { name: 'github' }] });
    expect(store.browserSessions['mac']).toEqual([{ name: 'perch-a' }, { name: 'github' }]);
    const ws = store.workspaces[0]!;
    expect(ws.machineId).toBe('mac');
    expect(store.browserSessionsFor(ws)).toEqual(['perch-a']);
  });

  it('flags browser support only once a browserSessions message arrives (even empty)', () => {
    const { store, sockets } = connected();
    expect(store.supportsBrowser('mac')).toBe(false);
    sockets['wss://mac']!.deliver({ type: 'browserSessions', sessions: [] });
    expect(store.supportsBrowser('mac')).toBe(true);
    expect(store.browserSessionsFor({ machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' })).toEqual([]);
  });

  it('startBrowser sends on the chosen connection only', () => {
    const { store, sockets } = build([mac, { ...mac, id: 'mini', name: 'Mini', url: 'wss://mini', token: 't2' }]);
    store.start();
    sockets['wss://mac']!.open();
    sockets['wss://mini']!.open();
    store.startBrowser('mini', 'perch-z');
    expect(sockets['wss://mini']!.sent.map((s) => JSON.parse(s))).toContainEqual({ type: 'startBrowser', workspaceId: 'perch-z' });
    expect(sockets['wss://mac']!.sent.map((s) => JSON.parse(s)).some((m) => m.type === 'startBrowser')).toBe(false);
  });

  it('lists unattached sessions per connection', () => {
    const { store, sockets } = connected();
    sockets['wss://mac']!.deliver({
      type: 'workspaces',
      workspaces: [
        { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' },
      ],
    });
    sockets['wss://mac']!.deliver({ type: 'browserSessions', sessions: [{ name: 'perch-a' }, { name: 'github' }] });
    expect(store.unattachedBrowserSessions()).toEqual([{ connectionId: 'mac', name: 'github' }]);
  });

  it('openBrowserView targets a session and closeBrowserView returns to the previous view', () => {
    const { store } = connected();
    store.openBrowserView('mac', 'github');
    expect(store.view).toBe('browserView');
    expect(store.browserTarget).toEqual({ connectionId: 'mac', session: 'github' });
    store.closeBrowserView();
    expect(store.view).toBe('list');
    expect(store.browserTarget).toBeNull();

    // From an open terminal, closing returns to the terminal.
    store.open({ machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/a', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' });
    store.openBrowserView('mac', 'perch-a');
    store.closeBrowserView();
    expect(store.view).toBe('terminal');
  });


  it('openBrowserStream returns null without an open target', () => {
    const { store } = connected();
    expect(store.openBrowserStream({ onFrame: () => undefined, onUrl: () => undefined, onState: () => undefined })).toBeNull();
  });

  it('browserSessionClosed re-lists the target connection and leaves the view', () => {
    const { store, sockets } = connected();
    store.openBrowserView('mac', 'perch-a');
    sockets['wss://mac']!.sent.length = 0;
    store.browserSessionClosed();
    expect(sockets['wss://mac']!.sent.map((s) => JSON.parse(s))).toContainEqual({ type: 'list' });
    expect(store.view).toBe('list');
    expect(store.browserTarget).toBeNull();
  });
});

const mini = { id: 'mini', name: 'Mini', url: 'wss://mini', token: 't', agentKey };

describe('PerchStore home view', () => {
  it('prompts to add a machine when none are configured, with no grace timer', () => {
    const timer = manualTimer();
    const { store } = build([], undefined, timer.startTimer);
    store.start();
    expect(store.homeView).toBe('add-machine');
    expect(timer.pending()).toBe(0);
  });

  it('ignores an old direct entry, even one switched on: no socket, no grace timer, no alarm', () => {
    const timer = manualTimer();
    const { store, sockets } = build([{ id: 'old', name: 'Old', url: 'wss://old', token: 't', enabled: true }], undefined, timer.startTimer);
    store.start();
    expect(sockets).toEqual({});
    expect(store.homeView).toBe('add-machine');
    expect(timer.pending()).toBe(0);
    store.reconnectAll(true);
    expect(sockets).toEqual({});
    expect(store.homeView).toBe('add-machine');
  });

  it('counts only the relay machines beside an old direct entry', () => {
    const timer = manualTimer();
    const { store } = build([{ id: 'old', name: 'Old', url: 'wss://old', token: 't' }, mac], undefined, timer.startTimer);
    store.start();
    store.setStatus('mac', 'online');
    expect(store.homeView).toBe('create');
  });

  it('arms the grace timer and shows connecting while no machine is online', () => {
    const timer = manualTimer();
    const { store } = build([mac], undefined, timer.startTimer);
    store.start();
    expect(store.homeView).toBe('connecting');
    expect(timer.pending()).toBe(1);
  });

  it('shows unreachable once the grace period elapses with nothing online', () => {
    const timer = manualTimer();
    const { store } = build([mac], undefined, timer.startTimer);
    store.start();
    timer.fireAll();
    expect(store.homeView).toBe('unreachable');
  });

  it('a machine coming online cancels grace and shows create when it reports no workspaces', () => {
    const timer = manualTimer();
    const { store } = build([mac], undefined, timer.startTimer);
    store.start();
    store.setStatus('mac', 'online');
    expect(timer.pending()).toBe(0);
    expect(store.homeView).toBe('create');
  });

  it('shows reconnecting after a machine drops, then falls through to unreachable after the long grace', () => {
    const timer = manualTimer();
    const { store } = build([mac], undefined, timer.startTimer);
    store.start();
    store.setStatus('mac', 'online');
    store.setStatus('mac', 'offline');
    // Known-reachable this session → a calm "Reconnecting…" within the (longer) grace window.
    expect(store.homeView).toBe('reconnecting');
    // …but a genuine extended outage must still surface the actionable "Can't reach" screen,
    // not an eternal spinner. The long reconnect grace elapsing does exactly that.
    timer.fireAll();
    expect(store.homeView).toBe('unreachable');
  });

  it('shows a final refusal at once, not "Reconnecting…", for a machine that was online', () => {
    const timer = manualTimer();
    const { store } = build([mac], undefined, timer.startTimer);
    store.start();
    store.setStatus('mac', 'online');
    store.setStatus('mac', 'offline');
    store.setConnectionError('mac', { message: 'This phone was revoked on mac', code: 4003, at: 1000, refused: true, final: true });
    expect(store.homeView).toBe('unreachable');
    expect(store.refusals).toEqual([{ id: 'mac', message: 'This phone was revoked on mac' }]);
  });

  it('keeps "Reconnecting…" for a refusal that is retried', () => {
    const timer = manualTimer();
    const { store } = build([mac], undefined, timer.startTimer);
    store.start();
    store.setStatus('mac', 'online');
    store.setStatus('mac', 'offline');
    store.setConnectionError('mac', { message: 'mac is not connected to the relay', code: 4503, at: 1000, refused: true, retryInMs: 1000 });
    expect(store.homeView).toBe('reconnecting');
  });

  it('reconnectAll only reconnects enabled machines that are not online', () => {
    const timer = manualTimer();
    const { store, manager } = build([mac, mini], undefined, timer.startTimer);
    store.start();
    store.setStatus('mac', 'online');
    store.setStatus('mini', 'offline');
    const spy = vi.spyOn(manager, 'reconnect');
    store.reconnectAll();
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['mini']);
  });

  // An attempt left in flight while the app was backgrounded fails right after it returns, and
  // would otherwise wait the backoff it built up in the background (up to 10s).
  it('reconnectAll resets the backoff of a connecting machine without aborting it', () => {
    const timer = manualTimer();
    const { store, manager } = build([mac, mini], undefined, timer.startTimer);
    store.start();
    store.setStatus('mac', 'connecting');
    store.setStatus('mini', 'online');
    const reconnect = vi.spyOn(manager, 'reconnect');
    const reset = vi.spyOn(manager, 'resetBackoff');
    store.reconnectAll();
    expect(reconnect).not.toHaveBeenCalled();
    expect(reset.mock.calls.map((c) => c[0])).toEqual(['mac']);
  });

  it('reconnectAll resets grace so the unreachable screen returns to connecting', () => {
    const timer = manualTimer();
    const { store, manager } = build([mac], undefined, timer.startTimer);
    store.start();
    timer.fireAll();
    expect(store.homeView).toBe('unreachable');
    store.setStatus('mac', 'offline'); // idling between backoff attempts → reconnectable
    const spy = vi.spyOn(manager, 'reconnect');
    store.reconnectAll();
    expect(spy).toHaveBeenCalledWith('mac');
    expect(store.homeView).toBe('connecting');
    expect(timer.pending()).toBe(1);
  });
});

describe('PerchStore connection logging', () => {
  function fakeLog() {
    const pushed: { machineId: string | null; kind: string; extra?: { code?: number; reason?: string } }[] = [];
    // A flush starts by reading the machine's pending events, so those reads are the flushes.
    const flushed: string[] = [];
    const connectionLog = {
      push(machineId: string | null, kind: string, extra?: { code?: number; reason?: string }) {
        pushed.push({ machineId, kind, extra });
        return { sess: 'x', seq: 0, t: 0, kind, online: true, vis: 'visible' };
      },
      pendingFor: (machineId: string) => (flushed.push(machineId), []),
      markFlushed: () => undefined,
      snapshot: () => [],
    };
    return { connectionLog, pushed, flushed };
  }

  it('records a connect event on connecting, and an online event that flushes the machine', () => {
    const lg = fakeLog();
    const { store } = build([mac], undefined, undefined, lg);
    store.start();
    store.setStatus('mac', 'connecting');
    store.setStatus('mac', 'online');
    expect(lg.pushed).toEqual([
      { machineId: 'mac', kind: 'connect', extra: undefined },
      { machineId: 'mac', kind: 'online', extra: undefined },
    ]);
    expect(lg.flushed).toEqual(['mac']);
  });

  it('records a close event carrying the diagnostic code and reason', () => {
    const lg = fakeLog();
    const { store } = build([mac], undefined, undefined, lg);
    store.start();
    store.setConnectionError('mac', { message: 'opened then dropped', code: 1006, at: 1 });
    expect(lg.pushed).toEqual([{ machineId: 'mac', kind: 'close', extra: { code: 1006, reason: 'opened then dropped' } }]);
  });

  it('records which failed attempt a close was, and the backoff before the next', () => {
    const lg = fakeLog();
    const { store } = build([mac], undefined, undefined, lg);
    store.start();
    store.setConnectionError('mac', { message: 'connection timed out', code: 1000, at: 1, attempt: 2, retryInMs: 500 });
    expect(lg.pushed).toEqual([{ machineId: 'mac', kind: 'close', extra: { code: 1000, reason: 'connection timed out [attempt 2, retry in 500ms]' } }]);
  });

  it('records a phase of a relay connect with its detail', () => {
    const lg = fakeLog();
    const { store } = build([mac], undefined, undefined, lg);
    store.start();
    store.logPhase('mac', 'challenge', 'timeout 5000ms');
    expect(lg.pushed).toEqual([{ machineId: 'mac', kind: 'challenge', extra: { reason: 'timeout 5000ms' } }]);
  });

  it('logConnectivity records an app-global event and flushes online machines only', () => {
    const lg = fakeLog();
    const { store } = build([mac, mini], undefined, undefined, lg);
    store.start();
    store.setStatus('mac', 'online');
    lg.flushed.length = 0; // ignore the flush from going online
    store.logConnectivity('hidden');
    expect(lg.pushed.at(-1)).toEqual({ machineId: null, kind: 'hidden', extra: undefined });
    expect(lg.flushed).toEqual(['mac']);
  });

  it('records a manual-reconnect event when the Reconnect button is used', () => {
    const lg = fakeLog();
    const { store } = build([mac], undefined, undefined, lg);
    store.start();
    store.reconnectMachine('mac');
    expect(lg.pushed).toContainEqual({ machineId: 'mac', kind: 'manual-reconnect', extra: undefined });
  });

  it('records an auto-reconnect event per machine reconnected by reconnectAll', () => {
    const lg = fakeLog();
    const { store } = build([mac], undefined, undefined, lg);
    store.start();
    store.setStatus('mac', 'offline'); // idle-offline → reconnectAll targets it
    store.reconnectAll();
    expect(lg.pushed).toContainEqual({ machineId: 'mac', kind: 'auto-reconnect', extra: undefined });
  });

  it('reconnectAll(true) records a manual-reconnect (the home Reconnect button)', () => {
    const lg = fakeLog();
    const { store } = build([mac], undefined, undefined, lg);
    store.start();
    store.setStatus('mac', 'offline');
    store.reconnectAll(true);
    expect(lg.pushed).toContainEqual({ machineId: 'mac', kind: 'manual-reconnect', extra: undefined });
  });
});

describe('PerchStore reconnect UX', () => {
  it('reconnectAll leaves a machine that is already connecting alone (no interrupt)', () => {
    const { store, manager } = build([mac]);
    store.start();
    store.setStatus('mac', 'connecting');
    const spy = vi.spyOn(manager, 'reconnect');
    store.reconnectAll();
    expect(spy).not.toHaveBeenCalled();
  });

  it('reconnectAll still reconnects an offline machine', () => {
    const { store, manager } = build([mac]);
    store.start();
    store.setStatus('mac', 'offline');
    const spy = vi.spyOn(manager, 'reconnect');
    store.reconnectAll();
    expect(spy).toHaveBeenCalledWith('mac');
  });

  it('shows the reconnecting home view while a machine that had connected is briefly down', () => {
    const { store } = build([mac]);
    store.start();
    store.setStatus('mac', 'online'); // now known-reachable this session
    store.setStatus('mac', 'offline'); // within the reconnect grace window
    expect(store.homeView).toBe('reconnecting');
  });

  it('shows unreachable (not reconnecting) for a machine that never connected', () => {
    const { store } = build([mac]);
    store.start();
    store.setStatus('mac', 'connecting');
    store.setStatus('mac', 'offline');
    store.graceElapsed = true;
    expect(store.homeView).toBe('unreachable');
  });
});

describe('PerchStore relay machines carry the side channels inside the session', () => {
  const key = 'A'.repeat(42) + 'Q';
  const relayMac = { ...mac, url: 'wss://relay.example/acct', agentKey: key };
  const ws = { machineId: 'mac', id: 'perch-a', name: 'a', projectPath: '/home/u/proj', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  function buildRelay(extra: Partial<ConstructorParameters<typeof PerchStore>[0]> = {}) {
    const sent: Array<Record<string, unknown>> = [];
    let deliver: (m: unknown) => void = () => undefined;
    let open: () => void = () => undefined;
    const socketFactory = () => {
      const socket: Socket = {
        send: (d) => sent.push(JSON.parse(d) as Record<string, unknown>),
        close: () => undefined,
        onMessage: (cb) => void (deliver = (m) => cb(JSON.stringify(m))),
        onOpen: (cb) => void (open = cb),
        onClose: () => undefined,
      };
      return socket;
    };
    const aggregator = new WorkspaceAggregator();
    const settings = new SettingsStore(memStorage([relayMac]));
    const manager = new ConnectionManager({
      secureSocketFactory: () => socketFactory,
      aggregator,
      onMessage: (id, m) => store.handleMessage(id, m),
      onStatus: (id, s) => store.setStatus(id, s),
      schedule: () => undefined,
    });
    const store = new PerchStore({ settings, manager, aggregator, ...prompts, ...extra });
    store.start();
    open();
    deliver({ type: 'authResult', ok: true });
    const bySent = (type: string) => sent.filter((m) => m.type === type);
    return { store, sent, deliver, bySent };
  }

  it('loads a media preview in chunks inside the session', async () => {
    const { store, deliver, bySent } = buildRelay();
    store.open(ws);
    store.openFile('/home/u/proj/a.png');
    const [request] = bySent('readMedia');
    expect(request).toMatchObject({ path: '/home/u/proj/a.png' });
    deliver({ type: 'media', id: request!.id, result: 'ok', mediaType: 'image/png', size: 3 });
    deliver({ type: 'mediaChunk', id: request!.id, seq: 0, data: btoa('\x01\x02\x03') });
    await settle();
    expect(bySent('mediaAck')).toEqual([{ type: 'mediaAck', id: request!.id, seq: 0 }]);
    expect(store.fileView?.blobUrl).toMatch(/^blob:/);
    expect(store.viewError).toBeNull();
  });

  it('shows the too-large state for a file over its cap', async () => {
    const { store, deliver, bySent } = buildRelay();
    store.open(ws);
    store.openFile('/home/u/proj/a.png');
    deliver({ type: 'media', id: bySent('readMedia')[0]!.id, result: 'too-large' });
    await settle();
    expect(store.fileView?.truncated).toBe(true);
  });

  it.each([
    ['forbidden', 'may not read it'],
    ['not-found', 'not found'],
  ] as const)('says why the agent refused a preview (%s)', async (result, words) => {
    const { store, deliver, bySent } = buildRelay();
    store.open(ws);
    store.openFile('/home/u/proj/a.png');
    deliver({ type: 'media', id: bySent('readMedia')[0]!.id, result });
    await settle();
    expect(store.viewError).toContain(words);
    expect(store.viewError).not.toMatch(/HTTP/);
  });

  it('cancels a transfer when the viewer moves to another file or closes', () => {
    const { store, bySent } = buildRelay();
    store.open(ws);
    store.openFile('/home/u/proj/a.png');
    store.openFile('/home/u/proj/b.png');
    store.closeViewer();
    expect(bySent('mediaCancel').map((m) => m.id)).toEqual(bySent('readMedia').map((m) => m.id));
  });

  it('opens the browser view as a stream inside the session', async () => {
    const { store, deliver, bySent } = buildRelay();
    deliver({ type: 'browserSessions', sessions: [{ name: 'perch-a' }] });
    expect(store.supportsBrowser('mac')).toBe(true);
    store.openBrowserView('mac', 'perch-a');
    const states: string[] = [];
    const stream = store.openBrowserStream({ onFrame: () => undefined, onUrl: () => undefined, onState: (s) => states.push(s) });
    stream!.open();
    await settle();
    const [opened] = bySent('browserOpen');
    expect(opened).toMatchObject({ session: 'perch-a' });
    expect(JSON.parse(bySent('browser')[0]!.data as string)).toEqual({ type: 'auth', token: '' });
    deliver({ type: 'browser', stream: opened!.stream, data: JSON.stringify({ type: 'authResult', ok: true }) });
    expect(states).toEqual(['connecting', 'online']);
    expect(bySent('browserAck')).toEqual([{ type: 'browserAck', stream: opened!.stream }]);
    stream!.close();
  });

  it('keeps the connection log buffered when the agent refuses the batch', async () => {
    const connectionLog = {
      push: () => ({ sess: 's', seq: 0, t: 0, kind: 'k', online: true, vis: 'visible' }),
      pendingFor: () => [{ sess: 's', seq: 4, t: 1, kind: 'online', online: true, vis: 'visible' }],
      markFlushed: vi.fn(),
      snapshot: () => [],
    };
    const { deliver, bySent } = buildRelay({ connectionLog });
    deliver({ type: 'clientLogAck', id: bySent('clientLog')[0]!.id, ok: false });
    await settle();
    expect(connectionLog.markFlushed).not.toHaveBeenCalled();
  });

  it('flushes the connection log inside the session and marks it flushed on the agent ack', async () => {
    let pending = [{ sess: 's', seq: 4, t: 1, kind: 'online', online: true, vis: 'visible' }];
    const flushedTo: number[] = [];
    const connectionLog = {
      push: () => ({ sess: 's', seq: 0, t: 0, kind: 'k', online: true, vis: 'visible' }),
      pendingFor: () => pending,
      markFlushed: (_m: string, seq: number) => {
        flushedTo.push(seq);
        pending = [];
      },
      snapshot: () => [],
    };
    const { deliver, bySent } = buildRelay({ connectionLog, logMeta: { shell: 'pwa' } });
    const [batch] = bySent('clientLog');
    expect(batch).toMatchObject({ batch: { shell: 'pwa', events: [{ seq: 4 }] } });
    deliver({ type: 'clientLogAck', id: batch!.id, ok: true });
    await settle();
    expect(flushedTo).toEqual([4]);
  });
});

describe('PerchStore device key', () => {
  type Info = import('./store.svelte').DeviceKeyInfo;
  const make = (deviceKey: () => Promise<Info>, replaceDeviceKey?: () => Promise<Info>, machines: MachineConfig[] = []) => {
    const aggregator = new WorkspaceAggregator();
    const manager = new ConnectionManager({
      secureSocketFactory: () => () => ({ send: () => undefined, close: () => undefined, onMessage: () => undefined, onOpen: () => undefined, onClose: () => undefined }),
      aggregator,
      onMessage: () => undefined,
      onStatus: () => undefined,
      schedule: () => undefined,
    });
    const settings = new SettingsStore(memStorage(machines));
    const store = new PerchStore({ settings, manager, aggregator, deviceKey, replaceDeviceKey, ...prompts });
    return Object.assign(store, { reconnected: vi.spyOn(manager, 'reconnect') });
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const fresh: Info = { fingerprint: 'new', storage: { x25519: 'noble', ed25519: 'noble' } };
  const unreadable = () => Promise.reject(new UnreadableDeviceKeyError('stored device key is unreadable'));

  it('offers a new device key only when the stored one is unreadable', async () => {
    const broken = make(unreadable, async () => fresh);
    const failing = make(() => Promise.reject(new Error('IndexedDB unavailable')), async () => fresh);
    const fine = make(async () => fresh, async () => fresh);
    await settle();
    expect(broken.deviceKeyUnreadable).toBe(true);
    expect(failing.deviceKeyUnreadable).toBe(false);
    expect(fine.deviceKeyUnreadable).toBe(false);
  });

  it('replaces an unreadable device key and reconnects the relay machines', async () => {
    const relay = { id: 'r', name: 'R', url: 'ws://relay/acct', token: 't', agentKey };
    const direct = { id: 'd', name: 'D', url: 'ws://direct', token: 't' };
    const replace = vi.fn(async () => fresh);
    const store = make(unreadable, replace, [relay, direct]);
    store.start();
    await settle();
    store.reconnected.mockClear();
    await store.replaceDeviceKey();
    expect(replace).toHaveBeenCalledOnce();
    expect(store.deviceKey?.fingerprint).toBe('new');
    expect(store.deviceKeyError).toBeNull();
    expect(store.deviceKeyUnreadable).toBe(false);
    expect(store.reconnected.mock.calls).toEqual([['r']]);
  });

  it('never replaces a readable device key', async () => {
    const replace = vi.fn(async () => fresh);
    const store = make(async () => ({ ...fresh, fingerprint: 'old' }), replace);
    await settle();
    await store.replaceDeviceKey();
    expect(replace).not.toHaveBeenCalled();
    expect(store.deviceKey?.fingerprint).toBe('old');
  });

  it('keeps the reason the device key could not be loaded, for Diagnostics', async () => {
    const store = make(() => Promise.reject(new DOMException('The object can not be cloned.', 'DataCloneError')));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.deviceKey).toBeNull();
    expect(store.deviceKeyError).toBe('DataCloneError: The object can not be cloned.');
  });

  it('has no error once the device key loads', async () => {
    const store = make(async () => ({ fingerprint: 'ab', storage: { x25519: 'noble', ed25519: 'noble' } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.deviceKey?.fingerprint).toBe('ab');
    expect(store.deviceKeyError).toBeNull();
  });
});
