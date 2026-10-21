import { test, expect } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';

let agent: FakeAgent;

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});

// Select mode covers the terminal with a plain-text snapshot that the browser's own selection
// works on. jsdom has no layout or selection, so whether a drag really selects the snapshot's
// text (and not xterm's unselectable rows beneath) is asserted here.
test('select mode shows a natively selectable snapshot of the terminal', async ({ page }) => {
  await seedMachine(page, agent);
  await page.goto('/');
  await page.getByText('demo', { exact: true }).click();
  await expect(page.locator('.xterm-rows').filter({ hasText: 'PERCH_READY' })).toBeVisible();

  const toggle = page.getByRole('button', { name: /select text/i });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const line = page.locator('.snapshot .line').filter({ hasText: 'PERCH_READY' });
  await expect(line).toBeVisible();

  const box = (await line.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, y, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('PERCH_READY');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.snapshot')).toHaveCount(0);
});
