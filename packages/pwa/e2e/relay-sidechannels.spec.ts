import { test, expect, type Page } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';
import { openWorkspaceMenu, isWideViewport } from './drawer';
import { failOnCspViolation } from './csp';

failOnCspViolation(test);

// A machine's media previews, browser view and connection-log flush ride its end-to-end
// session: the fake agent speaks Noise IK, like a relay-dialed socket on the real agent, and
// would refuse anything in plaintext.

let agent: FakeAgent;

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});
test.beforeEach(() => {
  agent.received.length = 0;
  agent.browserReceived.length = 0;
  agent.clientLogs.length = 0;
});

async function openDemo(page: Page): Promise<void> {
  await seedMachine(page, agent);
  await page.goto('/');
  await page.getByText('demo', { exact: true }).click();
  await expect(page.locator('.xterm-rows').filter({ hasText: 'PERCH_READY' })).toBeVisible();
}

test('an image previews through the session', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: /files/i }).click();
  await page.getByRole('button', { name: /logo\.png/ }).click();
  const img = page.locator('.frame img');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('src', /^blob:/);
  expect(agent.received.filter((m) => m.type === 'readMedia')).toEqual([
    expect.objectContaining({ path: '/home/u/workspace/demo/logo.png' }),
  ]);
  expect(agent.received.filter((m) => m.type === 'mediaAck')).toHaveLength(1);
});

test('a PDF previews through the session on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page);
  await openWorkspaceMenu(page);
  await page.getByRole('button', { name: /files/i }).click();
  await page.getByRole('button', { name: /report\.pdf/ }).click();
  await expect(page.locator('iframe.frame')).toHaveAttribute('src', /^blob:/);
});

test('the browser view streams through the session, acknowledging each message', async ({ page }) => {
  await openDemo(page);
  if (!isWideViewport(page)) await openWorkspaceMenu(page);
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await expect(page.getByLabel('URL')).toHaveValue('https://example.com/');
  await expect(page.locator('.browser-view canvas')).toBeVisible();
  // Each browser message is acknowledged, which is what paces the agent's frames.
  await expect.poll(() => agent.received.filter((m) => m.type === 'browserAck').length).toBeGreaterThanOrEqual(3);
  expect(agent.browserReceived[0]).toEqual({ session: 'perch-demo', message: { type: 'auth', token: '' } });

  await page.getByLabel('URL').fill('example.org');
  await page.getByLabel('URL').press('Enter');
  await expect.poll(() => agent.browserReceived.map((r) => r.message.type)).toContain('navigate');
});

test('the connection log flushes inside the session', async ({ page }) => {
  await openDemo(page);
  // Any batch: the previous test's page can still flush its own `hidden` after the log was cleared.
  const batches = () => agent.clientLogs as Array<{ shell?: string; events: Array<{ kind: string; machineId?: string }> }>;
  await expect.poll(() => batches().flatMap((b) => b.events.map((e) => e.kind))).toContain('online');
  expect(batches().every((b) => b.shell === 'pwa')).toBe(true);
});
