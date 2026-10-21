import { test, expect, type Page } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';

// Playwright's WebKit stores CryptoKeys in IndexedDB, which a real iPhone may refuse. These
// tests make IndexedDB fail the way a browser can, and check that a relay machine still gets a
// device key, or at least says exactly why it has none.

let agent: FakeAgent;

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});
test.beforeEach(() => {
  agent.received.length = 0;
});

async function seed(page: Page): Promise<void> {
  await seedMachine(page, agent);
}

test('a browser that cannot store a CryptoKey still connects, on a stored key, and says why', async ({ page }) => {
  await page.addInitScript(() => {
    const holdsCryptoKey = (value: unknown): boolean =>
      value instanceof CryptoKey ||
      (typeof value === 'object' && value !== null && Object.values(value).some(holdsCryptoKey));
    for (const method of ['add', 'put'] as const) {
      const original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (holdsCryptoKey(value)) throw new DOMException('The object can not be cloned.', 'DataCloneError');
        return original.call(this, value, key);
      };
    }
  });
  await seed(page);
  await page.goto('/');
  await expect(page.getByText('demo', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByTestId('device-key')).toContainText(
    'X25519 stored key (WebCrypto key could not be stored: DataCloneError: The object can not be cloned.)',
  );
});

test('without IndexedDB, a relay machine refuses to connect and names the cause', async ({ page }) => {
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => {
      throw new DOMException('storage is disabled', 'InvalidStateError');
    };
  });
  await seed(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();

  await expect(page.getByTestId('device-key')).toHaveText(
    'Device key unavailable: IndexedDB unavailable: InvalidStateError: storage is disabled',
  );
  await expect(page.getByTestId('diagnostic')).toContainText(
    'device key unavailable: IndexedDB unavailable: InvalidStateError: storage is disabled',
  );
  expect(agent.received.filter((m) => m.type === 'auth')).toEqual([]);
});

test('an unreadable stored device key can be replaced from Settings, and the relay machine reconnects', async ({ page }) => {
  await seed(page);
  await page.goto('/');
  await expect(page.getByText('demo', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByTestId('device-key')).toContainText('Device key ');
  await expect(page.getByRole('button', { name: 'Make a new device key' })).toHaveCount(0);

  // A record whose keys did not survive, as an older build left behind on iOS.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('perch-device', 1);
        open.onsuccess = () => {
          const tx = open.result.transaction('identity', 'readwrite');
          tx.objectStore('identity').put({ x25519: {}, ed25519: {} }, 'device');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      }),
  );
  await page.reload();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByTestId('device-key')).toContainText('stored device key is unreadable');
  await expect(page.getByTestId('diagnostic')).toContainText('Make a new device key');
  agent.received.length = 0;

  await page.getByRole('button', { name: 'Make a new device key' }).first().click();
  await expect(page.getByTestId('device-key')).toContainText('X25519 stored key');
  await expect(page.getByRole('button', { name: 'Make a new device key' })).toHaveCount(0);
  await expect.poll(() => agent.received.filter((m) => m.type === 'auth').length).toBeGreaterThan(0);
});
