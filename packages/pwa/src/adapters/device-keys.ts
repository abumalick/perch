import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { b64url } from '@perch/secure-channel';
import { describeError } from '../core/describe-error';
import { DeviceKeyError, UnreadableDeviceKeyError, type DeviceIdentity, type KeyStorage } from '../core/ports/device-identity';

// One key as stored: a WebCrypto pair whose private half cannot be read back, or raw bytes.
// `reason` says why a raw key is not a WebCrypto one; it is stored so later launches can show it.
type StoredKey =
  | { kind: 'webcrypto'; privateKey: CryptoKey; publicKey: Uint8Array }
  | { kind: 'noble'; privateKey: Uint8Array; publicKey: Uint8Array; reason?: string };

export interface StoredIdentity {
  x25519: StoredKey;
  ed25519: StoredKey;
}

// Holds the one identity record. `add` never overwrites: it returns false when a record exists
// already (another tab got there first), and the caller reads that one instead. `replace` is
// only ever used on the record this load has just added, never on an identity already in use.
// `remove` only ever deletes a record that reads back unreadable.
export interface IdentityRecordStore {
  get(): Promise<StoredIdentity | undefined>;
  add(record: StoredIdentity): Promise<boolean>;
  replace(record: StoredIdentity): Promise<void>;
  remove(): Promise<void>;
}

const isBytes = (value: unknown, length?: number) => value instanceof Uint8Array && (length === undefined || value.length === length);

// A record as it must read back. A browser may take a CryptoKey into IndexedDB without an error
// and give back something else (Playwright's Linux WebKit returns the record with its keys gone).
function isIntact(record: unknown): record is StoredIdentity {
  const key = (k: unknown) => {
    const { kind, privateKey, publicKey } = (k ?? {}) as Record<string, unknown>;
    if (!isBytes(publicKey, 32)) return false;
    if (kind === 'noble') return isBytes(privateKey, 32);
    return kind === 'webcrypto' && typeof (privateKey as CryptoKey | undefined)?.algorithm?.name === 'string';
  };
  const { x25519: x, ed25519: ed } = (record ?? {}) as Record<string, unknown>;
  return key(x) && key(ed);
}

const UNREADABLE = 'stored device key is unreadable: this browser did not keep it intact; use Make a new device key in Settings';
const unreadable = () => new UnreadableDeviceKeyError(UNREADABLE);

type Algorithm = 'X25519' | 'Ed25519';

async function dhWith(subtle: SubtleCrypto, privateKey: CryptoKey, remote: Uint8Array): Promise<Uint8Array> {
  const pub = await subtle.importKey('raw', new Uint8Array(remote), { name: 'X25519' }, true, []);
  return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: pub }, privateKey, 256));
}

async function signWith(subtle: SubtleCrypto, privateKey: CryptoKey, message: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await subtle.sign({ name: 'Ed25519' }, privateKey, message));
}

function nobleKey(algorithm: Algorithm, reason: string): StoredKey {
  const curve = algorithm === 'X25519' ? x25519 : ed25519;
  const privateKey = curve.utils.randomSecretKey();
  return { kind: 'noble', privateKey, publicKey: curve.getPublicKey(privateKey), reason };
}

// A WebCrypto key is kept only once it has done its job once: a browser can generate a key it
// then cannot use, and a stored key is never replaced.
async function generate(subtle: SubtleCrypto | undefined, algorithm: Algorithm): Promise<StoredKey> {
  if (!subtle) return nobleKey(algorithm, 'no WebCrypto');
  try {
    const usages: KeyUsage[] = algorithm === 'X25519' ? ['deriveBits'] : ['sign'];
    const pair = (await subtle.generateKey({ name: algorithm }, false, usages)) as CryptoKeyPair;
    const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    if (algorithm === 'X25519') await dhWith(subtle, pair.privateKey, publicKey);
    else await signWith(subtle, pair.privateKey, new Uint8Array(32));
    return { kind: 'webcrypto', privateKey: pair.privateKey, publicKey };
  } catch (err) {
    return nobleKey(algorithm, `WebCrypto ${algorithm} unusable: ${describeError(err)}`);
  }
}

async function asDeviceKeyError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new DeviceKeyError(describeError(err));
  }
}

function identityOf(record: StoredIdentity, subtle: SubtleCrypto | undefined): DeviceIdentity {
  const { x25519: xKey, ed25519: edKey } = record;
  const dh = (remote: Uint8Array): Promise<Uint8Array> =>
    asDeviceKeyError(async () =>
      xKey.kind === 'noble' ? x25519.getSharedSecret(xKey.privateKey, remote) : dhWith(subtle!, xKey.privateKey, remote),
    );
  const sign = (message: Uint8Array<ArrayBuffer>): Promise<Uint8Array> =>
    asDeviceKeyError(async () =>
      edKey.kind === 'noble' ? ed25519.sign(message, edKey.privateKey) : signWith(subtle!, edKey.privateKey, message),
    );
  const reason = (key: StoredKey) => (key.kind === 'noble' ? key.reason : undefined);
  return {
    x25519: { publicKey: xKey.publicKey, dh },
    x25519Public: b64url.encode(xKey.publicKey),
    ed25519Public: b64url.encode(edKey.publicKey),
    sign,
    storage: { x25519: xKey.kind as KeyStorage, ed25519: edKey.kind as KeyStorage },
    fallback: { x25519: reason(xKey), ed25519: reason(edKey) },
  };
}

// Loads this device's identity, creating it on first use. Both keys prefer WebCrypto and fall
// back to noble one by one, so a browser with Ed25519 but no X25519 still keeps its signing key
// unreadable. Where the store cannot keep a CryptoKey (a browser that will not clone one into
// IndexedDB), both keys become raw bytes, which any store can keep. A store that cannot be read
// fails the load outright: a key made anyway would be a new device on every launch.
export async function loadDeviceIdentity(
  store: IdentityRecordStore,
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
): Promise<DeviceIdentity> {
  const existing = await store.get();
  if (existing !== undefined) {
    if (!isIntact(existing)) throw unreadable();
    return identityOf(existing, subtle);
  }
  let record: StoredIdentity = { x25519: await generate(subtle, 'X25519'), ed25519: await generate(subtle, 'Ed25519') };
  let added: boolean;
  try {
    added = await store.add(record);
  } catch (err) {
    if (record.x25519.kind === 'noble' && record.ed25519.kind === 'noble') {
      throw new Error(`device key could not be stored: ${describeError(err)}`);
    }
    const reason = `WebCrypto key could not be stored: ${describeError(err)}`;
    record = { x25519: nobleKey('X25519', reason), ed25519: nobleKey('Ed25519', reason) };
    try {
      added = await store.add(record);
    } catch (again) {
      throw new Error(`device key could not be stored: ${describeError(again)}`);
    }
  }
  if (!added) {
    const theirs = await store.get();
    if (!isIntact(theirs)) throw unreadable();
    return identityOf(theirs, subtle);
  }
  if (!isIntact(await store.get())) {
    if (record.x25519.kind === 'noble' && record.ed25519.kind === 'noble') throw unreadable();
    const reason = 'WebCrypto key did not read back from IndexedDB';
    record = { x25519: nobleKey('X25519', reason), ed25519: nobleKey('Ed25519', reason) };
    await store.replace(record);
    if (!isIntact(await store.get())) throw unreadable();
  }
  return identityOf(record, subtle);
}

// Replaces a stored identity that reads back malformed with a new one, made the way a first
// launch makes it. Refuses a record that reads back intact: that one may be enrolled, and
// replacing it would silently change this device's identity.
export async function replaceUnreadableDeviceIdentity(
  store: IdentityRecordStore,
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
): Promise<DeviceIdentity> {
  const existing = await store.get();
  if (existing !== undefined && isIntact(existing)) throw new Error('the stored device key is readable; it is kept');
  if (existing !== undefined) await store.remove();
  return loadDeviceIdentity(store, subtle);
}

const DB = 'perch-device';
const STORE = 'identity';
const KEY = 'device';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// IndexedDB keeps CryptoKey objects as they are (structured clone), so a non-extractable key
// survives reloads and PWA updates without ever being exported. The origin never changes, so
// neither does the key.
export function indexedDbIdentityStore(
  factory: IDBFactory | null | undefined = globalThis.indexedDB,
): IdentityRecordStore {
  const open = async (): Promise<IDBDatabase> => {
    try {
      if (!factory) throw new Error('not supported here');
      const req = factory.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      return await request(req);
    } catch (err) {
      throw new Error(`IndexedDB unavailable: ${describeError(err)}`);
    }
  };
  // A request can succeed and its transaction still abort at commit (a value WebKit cannot
  // serialize then), so a write counts only once the transaction completes.
  const write = async (run: (store: IDBObjectStore) => IDBRequest): Promise<void> => {
    const db = await open();
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      done.catch(() => undefined);
      const req = run(tx.objectStore(STORE));
      await Promise.all([request(req), done]);
    } finally {
      db.close();
    }
  };
  return {
    async get() {
      const db = await open();
      try {
        return (await request(db.transaction(STORE).objectStore(STORE).get(KEY))) as StoredIdentity | undefined;
      } catch (err) {
        throw new Error(`stored device key could not be read: ${describeError(err)}`);
      } finally {
        db.close();
      }
    },
    replace: (record) => write((store) => store.put(record, KEY)),
    remove: () => write((store) => store.delete(KEY)),
    async add(record) {
      try {
        await write((store) => store.add(record, KEY));
        return true;
      } catch (err) {
        if ((err as DOMException | null)?.name === 'ConstraintError') return false;
        throw err;
      }
    },
  };
}
