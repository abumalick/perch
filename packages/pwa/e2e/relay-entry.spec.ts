import { test, expect } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';

// An entry that cannot open the end-to-end session must never connect at all: without an agent
// key there is nothing to pin, and its token would reach the relay in plaintext. The fake agent
// counts every upgrade and records every `auth` that reaches it, so either one is that leak.

let agent: FakeAgent;

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});
test.beforeEach(() => {
  agent.received.length = 0;
  agent.upgrades = 0;
});

const stored = (page: import('@playwright/test').Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('perch.machines') ?? '[]') as Array<Record<string, unknown>>);

test('an entry without a valid agent key is an old direct entry, even one flagged relay', async ({ page }) => {
  await seedMachine(page, agent, { agentKey: undefined });
  await page.goto('/');
  await page.getByRole('button', { name: /add a machine/i }).click();

  await expect(page.getByTestId('legacy-entry')).toBeVisible();
  await expect(page.getByTestId('reconnect')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(agent.upgrades).toBe(0);
  expect(agent.received.filter((m) => m.type === 'auth')).toEqual([]);
});

test('the agent key of an entry cannot be cleared', async ({ page }) => {
  // A key the fake agent cannot answer, at a port nothing listens on: the entry is up but
  // never gets past the handshake.
  const agentKey = 'A'.repeat(42) + 'Q';
  await seedMachine(page, agent, { url: 'ws://127.0.0.1:59998/acct', agentKey });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();

  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('edit-agent-key').fill('');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('alert')).toContainText('agent key');
  expect(await stored(page)).toEqual([expect.objectContaining({ agentKey })]);
  expect(agent.received.filter((m) => m.type === 'auth')).toEqual([]);
});

test('an old direct entry is shown as unsupported, never connected, and can be deleted', async ({ page }) => {
  // What an older version of the app stored: switched on, no relay flag, no key.
  await seedMachine(page, agent, { url: `ws://127.0.0.1:${agent.port}`, relay: undefined, agentKey: undefined, enabled: true });
  await page.goto('/');

  // On its own it is no machine at all: the add-machine prompt, never "Can't reach".
  await expect(page.getByTestId('home-add-machine')).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('home-unreachable')).toHaveCount(0);

  await page.getByRole('button', { name: /add a machine/i }).click();
  await expect(page.getByText('Old direct entry — no longer supported; pair this machine again')).toBeVisible();
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(page.getByTestId('reconnect')).toHaveCount(0);
  expect(agent.upgrades).toBe(0);
  expect(agent.received).toEqual([]);

  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Old direct entry')).toHaveCount(0);
  expect(await stored(page)).toEqual([]);
  expect(agent.upgrades).toBe(0);
});
