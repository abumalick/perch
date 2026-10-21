import { test, expect } from '@playwright/test';
import { openWorkspaceMenu } from './drawer';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';
import { pagePolicy } from './csp';

// A blob: URL has the PWA's origin, so whatever a blob renders as runs with access to every
// machine entry and the device keys. The type a preview is built with must be the one its path
// implies, never the one the agent names.
let agent: FakeAgent;

const PAYLOAD = Buffer.from('<script>parent.document.body.dataset.pwned = "1"</script>', 'utf8');

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});

test('a .pdf the agent answers as text/html is refused, and its script never runs', async ({ page }) => {
  agent.mediaOverrides.set('report.pdf', { type: 'text/html', bytes: PAYLOAD });
  await page.setViewportSize({ width: 390, height: 844 });
  await seedMachine(page, agent);
  await page.goto('/');
  await page.getByText('demo', { exact: true }).click();
  await expect(page.locator('.xterm-rows').filter({ hasText: 'PERCH_READY' })).toBeVisible();

  await openWorkspaceMenu(page);
  await page.getByRole('button', { name: /files/i }).click();
  await page.getByRole('button', { name: /report\.pdf/ }).click();

  await expect(page.getByText("Couldn't open this file.")).toBeVisible();
  await expect(page.locator('iframe.frame')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.dataset.pwned)).toBeUndefined();
  agent.mediaOverrides.clear();
});

// The second wall: even an HTML blob that did get framed runs no script, because a blob document
// inherits the page's policy and that allows no inline script.
test('the page policy keeps an HTML blob from running script', async ({ page }) => {
  await page.goto('/');
  expect(await pagePolicy(page)).toContain("script-src 'self'");
  await page.evaluate((html) => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const frame = document.createElement('iframe');
    frame.src = url;
    document.body.append(frame);
  }, PAYLOAD.toString('utf8'));
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.body.dataset.pwned)).toBeUndefined();
});
