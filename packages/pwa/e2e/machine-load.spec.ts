import { test, expect } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';

let agent: FakeAgent;

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});

// jsdom has no layout, so these two runs are the only proof that the strip is visible and
// not clipped away at either size.
test('tablet width shows the load figures', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1100 });
  await seedMachine(page, agent);
  await page.goto('/');

  const strip = page.getByTestId('machine-load');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('CPU 12%');
  // The headline. An optional protocol field is stripped by the client parser when it is
  // missing from the schema, and every unit test on both sides stays green when that
  // happens — only a real wire round-trip proves it reaches the DOM.
  await expect(page.getByTestId('machine-load-headroom')).toContainText('6.0G');
  await expect(page.getByTestId('machine-load-ram')).toContainText('9.0G before kill');
});

test('phone width keeps the strip on one line', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedMachine(page, agent);
  await page.goto('/');

  const strip = page.getByTestId('machine-load');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('CPU 12%');
  await expect(page.getByTestId('machine-load-headroom')).toContainText('6.0G');
  // One line: the strip must not grow taller on a narrow screen, nor push the page sideways.
  expect((await strip.boundingBox())!.height).toBeLessThan(28);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

// jsdom has no layout, so it cannot see either half of this: that the button survives the
// strip's `overflow: hidden` (the bug that bit CommandPicker), and that its 32px tap target
// really is 32px rather than a padding that collapsed.
test('the help button is tappable and explains the figures', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedMachine(page, agent);
  await page.goto('/');

  const help = page.getByTestId('machine-load-help-open');
  await expect(help).toBeVisible();
  const box = (await help.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(32);
  expect(box.width).toBeGreaterThanOrEqual(32);
  // Square, or the 50% radius renders an ellipse — which both size assertions above allow.
  expect(box.width).toBeCloseTo(box.height, 0);
  // The button must not have bought its tap target by making the strip taller.
  expect((await page.getByTestId('machine-load').boundingBox())!.height).toBeLessThan(28);

  await help.click();
  const panel = page.getByTestId('machine-load-help');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('6.0G left');
  await expect(panel).toContainText('9.0G before kill');
  await page.getByRole('button', { name: /done/i }).click();
  await expect(panel).toBeHidden();
});
