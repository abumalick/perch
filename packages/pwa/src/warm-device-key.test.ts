import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { indexedDbIdentityStore } from './adapters/device-keys';

// Loads public/warm-device-key.js against a stub IndexedDB.
const script = readFileSync(join(__dirname, '../public/warm-device-key.js'), 'utf8');

// An IndexedDB whose open request the test settles by hand.
function fakeIndexedDb() {
  const db = { close: vi.fn() };
  const transaction = { abort: vi.fn() };
  const req = { result: db, transaction } as unknown as IDBOpenDBRequest;
  const open = vi.fn((_name: string, _version?: number) => req);
  return { factory: { open } as unknown as IDBFactory, open, req, db, transaction };
}

const run = (indexedDB: unknown) => new Function('indexedDB', script)(indexedDB);

describe('warm-device-key.js', () => {
  it('opens the database the device key lives in, at whatever version it has, and closes it', async () => {
    const app = fakeIndexedDb();
    void indexedDbIdentityStore(app.factory).get().catch(() => undefined);
    const warm = fakeIndexedDb();
    run(warm.factory);
    expect(warm.open).toHaveBeenCalledWith(app.open.mock.calls[0]![0]);
    warm.req.onsuccess?.(new Event('success'));
    expect(warm.db.close).toHaveBeenCalled();
  });

  it('creates nothing on a first launch: the upgrade is aborted, for the app to make', () => {
    const warm = fakeIndexedDb();
    run(warm.factory);
    warm.req.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent);
    expect(warm.transaction.abort).toHaveBeenCalled();
    const failed = new Event('error', { cancelable: true });
    warm.req.onerror?.(failed);
    expect(failed.defaultPrevented).toBe(true);
  });

  it('does nothing where IndexedDB is missing or refused', () => {
    expect(() => run(undefined)).not.toThrow();
    expect(() => run({ open: () => { throw new DOMException('denied', 'SecurityError'); } })).not.toThrow();
  });
});
