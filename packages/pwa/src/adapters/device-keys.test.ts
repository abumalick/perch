import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { IkInitiator, IkResponder, b64url, generateAgentKeys } from '@perch/secure-channel';
import { DeviceKeyError, UnreadableDeviceKeyError } from '../core/ports/device-identity';
import {
  indexedDbIdentityStore,
  loadDeviceIdentity,
  replaceUnreadableDeviceIdentity,
  type IdentityRecordStore,
  type StoredIdentity,
} from './device-keys';

class MemoryStore implements IdentityRecordStore {
  record: StoredIdentity | undefined;
  async get() {
    return this.record;
  }
  async add(record: StoredIdentity) {
    if (this.record) return false;
    this.record = record;
    return true;
  }
  async replace(record: StoredIdentity) {
    this.record = record;
  }
  async remove() {
    this.record = undefined;
  }
}

// A store that takes a CryptoKey without complaint and gives back something else: the record
// reads back with its keys missing, as Playwright's Linux WebKit does.
class CorruptingStore extends MemoryStore {
  override async get() {
    const record = this.record;
    if (record && (record.x25519.kind === 'webcrypto' || record.ed25519.kind === 'webcrypto')) return {} as StoredIdentity;
    return record;
  }
}

// Node's WebCrypto has X25519 and Ed25519, like current Chromium and Safari 18.4+.
const subtle = webcrypto.subtle as unknown as SubtleCrypto;
// A browser whose WebCrypto knows neither curve.
const withoutCurves = {
  ...subtle,
  generateKey: () => Promise.reject(new DOMException('unsupported', 'NotSupportedError')),
} as unknown as SubtleCrypto;

async function agreesWithAgent(identity: Awaited<ReturnType<typeof loadDeviceIdentity>>) {
  const agent = generateAgentKeys();
  const initiator = new IkInitiator(identity.x25519, b64url.decode(agent.x25519.publicKey));
  const responder = new IkResponder(b64url.decode(agent.x25519.privateKey));
  responder.readMessage1(await initiator.writeMessage1());
  expect(b64url.encode(responder.remoteStatic())).toBe(identity.x25519Public);
  await initiator.readMessage2(responder.writeMessage2());
}

describe('device identity', () => {
  it('uses non-extractable WebCrypto keys where the browser has both curves', async () => {
    const store = new MemoryStore();
    const identity = await loadDeviceIdentity(store, subtle);
    expect(identity.storage).toEqual({ x25519: 'webcrypto', ed25519: 'webcrypto' });
    expect(store.record!.x25519.kind).toBe('webcrypto');
    const privateKey = store.record!.x25519.privateKey as CryptoKey;
    expect(privateKey.extractable).toBe(false);
    await expect(subtle.exportKey('pkcs8', privateKey)).rejects.toThrow();
    await agreesWithAgent(identity);
  });

  it('signs challenges with the stored Ed25519 key', async () => {
    const identity = await loadDeviceIdentity(new MemoryStore(), subtle);
    const message = new TextEncoder().encode('challenge');
    expect(ed25519.verify(await identity.sign(message), message, b64url.decode(identity.ed25519Public))).toBe(true);
  });

  it('falls back to noble keys where WebCrypto lacks the curves, and they work the same', async () => {
    const identity = await loadDeviceIdentity(new MemoryStore(), withoutCurves);
    expect(identity.storage).toEqual({ x25519: 'noble', ed25519: 'noble' });
    expect(identity.fallback.x25519).toContain('NotSupportedError: unsupported');
    await agreesWithAgent(identity);
    const message = new TextEncoder().encode('challenge');
    expect(ed25519.verify(await identity.sign(message), message, b64url.decode(identity.ed25519Public))).toBe(true);
  });

  it('keeps the same keys across loads', async () => {
    const store = new MemoryStore();
    const first = await loadDeviceIdentity(store, subtle);
    const second = await loadDeviceIdentity(store, subtle);
    expect(second.x25519Public).toBe(first.x25519Public);
    expect(second.ed25519Public).toBe(first.ed25519Public);
  });

  it('adopts the identity another tab stored first', async () => {
    const store = new MemoryStore();
    const other = await loadDeviceIdentity(new MemoryStore(), subtle);
    let reads = 0;
    const racing: IdentityRecordStore = {
      get: async () => (reads++ === 0 ? undefined : store.record),
      add: async () => false,
      replace: async () => undefined,
      remove: async () => undefined,
    };
    await loadDeviceIdentity(store, subtle);
    const adopted = await loadDeviceIdentity(racing, subtle);
    expect(adopted.x25519Public).toBe((await loadDeviceIdentity(store, subtle)).x25519Public);
    expect(adopted.x25519Public).not.toBe(other.x25519Public);
  });
});

const cloneError = () => new DOMException('The object can not be cloned.', 'DataCloneError');
const hasCryptoKey = (record: StoredIdentity) =>
  record.x25519.kind === 'webcrypto' || record.ed25519.kind === 'webcrypto';

// A store that, like IndexedDB where the browser cannot serialise a CryptoKey, refuses a record
// holding one and accepts raw bytes.
class NoCryptoKeyStore extends MemoryStore {
  override async add(record: StoredIdentity) {
    if (hasCryptoKey(record)) throw cloneError();
    return super.add(record);
  }
}

async function works(identity: Awaited<ReturnType<typeof loadDeviceIdentity>>) {
  await agreesWithAgent(identity);
  const message = new TextEncoder().encode('challenge');
  expect(ed25519.verify(await identity.sign(message), message, b64url.decode(identity.ed25519Public))).toBe(true);
}

describe('device identity failures', () => {
  it('keeps a WebCrypto key that generates but cannot derive out of the identity', async () => {
    const broken = {
      ...subtle,
      generateKey: subtle.generateKey.bind(subtle),
      exportKey: subtle.exportKey.bind(subtle),
      importKey: subtle.importKey.bind(subtle),
      sign: subtle.sign.bind(subtle),
      deriveBits: () => Promise.reject(new DOMException('derive failed', 'OperationError')),
    } as unknown as SubtleCrypto;
    const identity = await loadDeviceIdentity(new MemoryStore(), broken);
    expect(identity.storage).toEqual({ x25519: 'noble', ed25519: 'webcrypto' });
    expect(identity.fallback.x25519).toContain('OperationError: derive failed');
    await agreesWithAgent(identity);
  });

  it('keeps a WebCrypto key that generates but cannot sign out of the identity', async () => {
    const broken = {
      generateKey: subtle.generateKey.bind(subtle),
      exportKey: subtle.exportKey.bind(subtle),
      importKey: subtle.importKey.bind(subtle),
      deriveBits: subtle.deriveBits.bind(subtle),
      sign: () => Promise.reject(new DOMException('sign failed', 'OperationError')),
    } as unknown as SubtleCrypto;
    const identity = await loadDeviceIdentity(new MemoryStore(), broken);
    expect(identity.storage).toEqual({ x25519: 'webcrypto', ed25519: 'noble' });
    expect(identity.fallback.ed25519).toContain('OperationError: sign failed');
  });

  it('stores noble keys as raw bytes when the store cannot clone a CryptoKey, and says why', async () => {
    const store = new NoCryptoKeyStore();
    const identity = await loadDeviceIdentity(store, subtle);
    expect(identity.storage).toEqual({ x25519: 'noble', ed25519: 'noble' });
    expect(identity.fallback.x25519).toBe('WebCrypto key could not be stored: DataCloneError: The object can not be cloned.');
    expect(identity.fallback.ed25519).toBe(identity.fallback.x25519);
    expect(store.record!.x25519.privateKey).toBeInstanceOf(Uint8Array);
    await works(identity);
    // The reason is part of the record, so the next launch still shows it.
    const again = await loadDeviceIdentity(store, subtle);
    expect(again.x25519Public).toBe(identity.x25519Public);
    expect(again.fallback).toEqual(identity.fallback);
  });

  it('replaces its own new WebCrypto keys with stored noble keys when they do not read back intact', async () => {
    const store = new CorruptingStore();
    const identity = await loadDeviceIdentity(store, subtle);
    expect(identity.storage).toEqual({ x25519: 'noble', ed25519: 'noble' });
    expect(identity.fallback.x25519).toMatch(/did not read back/);
    await works(identity);
    const again = await loadDeviceIdentity(store, subtle);
    expect(again.x25519Public).toBe(identity.x25519Public);
  });

  it('refuses a stored identity that reads back malformed, naming the way out, and never replaces it', async () => {
    const store = new MemoryStore();
    store.record = {} as StoredIdentity;
    const load = loadDeviceIdentity(store, subtle);
    await expect(load).rejects.toBeInstanceOf(UnreadableDeviceKeyError);
    await expect(load).rejects.toThrow(/stored device key is unreadable.*Make a new device key/);
    expect(store.record).toEqual({});
  });

  it('replaces an unreadable stored identity with a new one that reads back', async () => {
    const store = new CorruptingStore();
    store.record = { x25519: {}, ed25519: {} } as unknown as StoredIdentity;
    const identity = await replaceUnreadableDeviceIdentity(store, subtle);
    expect(identity.storage).toEqual({ x25519: 'noble', ed25519: 'noble' });
    await works(identity);
    const again = await loadDeviceIdentity(store, subtle);
    expect(again.x25519Public).toBe(identity.x25519Public);
  });

  it('never replaces a stored identity that reads back intact', async () => {
    const store = new MemoryStore();
    const identity = await loadDeviceIdentity(store, subtle);
    const stored = store.record;
    await expect(replaceUnreadableDeviceIdentity(store, subtle)).rejects.toThrow(/readable/);
    expect(store.record).toBe(stored);
    expect((await loadDeviceIdentity(store, subtle)).x25519Public).toBe(identity.x25519Public);
  });

  it('adopts another tab’s identity when it wins the race during the fallback', async () => {
    const theirs = new MemoryStore();
    await loadDeviceIdentity(theirs, withoutCurves);
    let reads = 0;
    const racing: IdentityRecordStore = {
      get: async () => (reads++ === 0 ? undefined : theirs.record),
      add: async (record) => {
        if (hasCryptoKey(record)) throw cloneError();
        return false;
      },
      replace: async () => undefined,
      remove: async () => undefined,
    };
    const identity = await loadDeviceIdentity(racing, subtle);
    expect(identity.x25519Public).toBe(b64url.encode(theirs.record!.x25519.publicKey));
  });

  it('fails, rather than using a key it cannot keep, when even raw bytes cannot be stored', async () => {
    const store: IdentityRecordStore = {
      get: async () => undefined,
      add: () => Promise.reject(new DOMException('disk full', 'QuotaExceededError')),
      replace: async () => undefined,
      remove: async () => undefined,
    };
    await expect(loadDeviceIdentity(store, subtle)).rejects.toThrow(
      'device key could not be stored: QuotaExceededError: disk full',
    );
  });

  it('never generates a key when the stored identity cannot be read', async () => {
    let added = false;
    const store: IdentityRecordStore = {
      get: () => Promise.reject(new Error('IndexedDB unavailable: UnknownError: gone')),
      add: async () => (added = true),
      replace: async () => undefined,
      remove: async () => undefined,
    };
    await expect(loadDeviceIdentity(store, subtle)).rejects.toThrow('IndexedDB unavailable: UnknownError: gone');
    expect(added).toBe(false);
  });

  it('reports a stored key that fails to derive or sign as a device key error, and keeps it', async () => {
    const store = new MemoryStore();
    await loadDeviceIdentity(store, subtle);
    const stored = store.record;
    const failing = {
      importKey: subtle.importKey.bind(subtle),
      deriveBits: () => Promise.reject(new DOMException('key gone', 'InvalidAccessError')),
      sign: () => Promise.reject(new DOMException('key gone', 'InvalidAccessError')),
    } as unknown as SubtleCrypto;
    const identity = await loadDeviceIdentity(store, failing);
    const remote = b64url.decode(generateAgentKeys().x25519.publicKey);
    await expect(identity.x25519.dh(remote)).rejects.toBeInstanceOf(DeviceKeyError);
    await expect(identity.x25519.dh(remote)).rejects.toThrow('InvalidAccessError: key gone');
    await expect(identity.sign(new Uint8Array(3))).rejects.toBeInstanceOf(DeviceKeyError);
    expect(store.record).toBe(stored);
  });
});

// Just enough of an IDBFactory whose open fails, as it does where the browser refuses storage.
function failingFactory(fail: 'event' | 'throw'): IDBFactory {
  return {
    open: () => {
      if (fail === 'throw') throw new DOMException('denied', 'SecurityError');
      const req = { error: new DOMException('open failed', 'UnknownError') } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => req.onerror?.(new Event('error')));
      return req;
    },
  } as unknown as IDBFactory;
}

// An IDBFactory whose writes' requests succeed but whose transaction then aborts, as a commit
// that fails to serialize does.
function abortingCommitFactory(): IDBFactory {
  const fire = (target: Record<string, unknown>, handler: string) => queueMicrotask(() => (target[handler] as (() => void) | null)?.());
  const db = {
    close: () => undefined,
    transaction: () => {
      const tx: Record<string, unknown> = { error: new DOMException('commit failed', 'DataCloneError') };
      const request = (): IDBRequest => {
        const req: Record<string, unknown> = { result: undefined };
        fire(req, 'onsuccess');
        queueMicrotask(() => fire(tx, 'onabort'));
        return req as unknown as IDBRequest;
      };
      tx.objectStore = () => ({ add: request, put: request, get: request, delete: request });
      return tx;
    },
  };
  return {
    open: () => {
      const req = { result: db } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => req.onsuccess?.(new Event('success')));
      return req;
    },
  } as unknown as IDBFactory;
}

describe('indexedDbIdentityStore', () => {
  it('fails a write whose transaction aborts after its request succeeded', async () => {
    const store = indexedDbIdentityStore(abortingCommitFactory());
    await expect(store.add({} as StoredIdentity)).rejects.toThrow('commit failed');
    await expect(store.replace({} as StoredIdentity)).rejects.toThrow('commit failed');
    await expect(store.remove()).rejects.toThrow('commit failed');
  });

  it('says IndexedDB is unavailable when the browser has none', async () => {
    const store = indexedDbIdentityStore(null);
    await expect(store.get()).rejects.toThrow('IndexedDB unavailable: not supported here');
  });

  it('says IndexedDB is unavailable, with the cause, when it cannot be opened', async () => {
    await expect(indexedDbIdentityStore(failingFactory('event')).get()).rejects.toThrow(
      'IndexedDB unavailable: UnknownError: open failed',
    );
    await expect(indexedDbIdentityStore(failingFactory('throw')).add({} as StoredIdentity)).rejects.toThrow(
      'IndexedDB unavailable: SecurityError: denied',
    );
  });
});
