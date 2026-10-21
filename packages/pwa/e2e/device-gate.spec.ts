import { test, expect, type Page } from '@playwright/test';
import { pairingLink } from '@perch/secure-channel';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';
import { failOnCspViolation } from './csp';

failOnCspViolation(test);

// The relay admits a phone by the device key the agent published, after the phone signs the
// relay's challenge with it: the whole gate, in WebKit, against the real relay server.

let agent: FakeAgent;

test.beforeEach(async () => {
  agent = await startFakeAgent();
});
test.afterEach(async () => {
  await agent.close();
});

async function pair(page: Page, baseURL: string): Promise<void> {
  const secret = await agent.newPairing();
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(pairingLink(baseURL, { url: agent.url, agentKey: agent.agentKey, secret, name: 'dev box' }));
  await expect(page.getByText('demo', { exact: true })).toBeVisible();
}

test('an unknown key with no credential is refused by the relay, and not redialed', async ({ page }) => {
  await seedMachine(page, agent, { token: '' });
  await page.goto('/');
  await expect(page.getByTestId('home-refusal')).toHaveText('This phone is not enrolled on Test — run `perch pair` there to pair it again');
  expect(agent.received).toEqual([]);
  const upgrades = agent.upgrades;
  expect(upgrades).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  expect(agent.upgrades).toBe(upgrades);
});

test('a paired key is admitted by the relay on its own: no proof, no token', async ({ page, baseURL }) => {
  await pair(page, baseURL!);
  agent.received.length = 0;
  await page.reload();
  await expect(page.getByText('demo', { exact: true })).toBeVisible();
  expect(agent.received.filter((m) => m.type === 'auth')).toEqual([{ type: 'auth', token: '' }]);
});

test('a revoked key loses its session at once and is refused from then on', async ({ page, baseURL }) => {
  await pair(page, baseURL!);
  await agent.revokeAll();
  await expect(page.getByTestId('home-refusal')).toHaveText('This phone was revoked on dev box');

  agent.received.length = 0;
  await page.reload();
  await expect(page.getByTestId('home-refusal')).toHaveText('This phone was revoked on dev box');
  expect(agent.received).toEqual([]);
});
