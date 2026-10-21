import { test, expect, type Page } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';
import { openWorkspaceMenu } from './drawer';

// Each test parks a workspace, and the fake agent's status is shared state, so each test
// gets its own agent rather than depending on the order the tests run in.
let agent: FakeAgent;

test.beforeEach(async () => {
  agent = await startFakeAgent();
});
test.afterEach(async ({ page }) => {
  // The agent waits on its open sockets, so the page has to let go of its one first.
  await page.close();
  await agent.close();
});

async function parkDemo(page: Page): Promise<void> {
  await page.getByText('demo', { exact: true }).click();
  await expect(page.locator('.xterm-rows').filter({ hasText: 'PERCH_READY' })).toBeVisible();
  await openWorkspaceMenu(page);
  await page.getByRole('button', { name: /status: needs you/i }).click();
  await page.getByRole('option', { name: /parked/i }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
}

// Parking folds a workspace behind a collapsed "Parked" row at the end of the list; the
// row's open state lives in the store, so it survives opening a workspace and returning.
test('parked workspaces fold behind a collapsed row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedMachine(page, agent);
  await page.goto('/');

  const rowNames = page.locator('.row .name');
  await expect(rowNames).toHaveText(['demo', 'other']);
  await expect(page.getByRole('button', { name: /parked ·/i })).toHaveCount(0);

  await parkDemo(page);

  const toggle = page.getByRole('button', { name: /parked · 1/i });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(rowNames).toHaveText(['other']);

  await toggle.click();
  await expect(rowNames).toHaveText(['other', 'demo']);

  await page.getByText('other', { exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('button', { name: /parked · 1/i })).toHaveAttribute('aria-expanded', 'true');
  await expect(rowNames).toHaveText(['other', 'demo']);
});

// Expanding the group scrolls its header toward the top so the revealed rows are on screen
// rather than below the fold. A short viewport makes the fold bite with only one row; with
// that little content below it the header can't reach the very top, so the test asserts
// what the user needs — the revealed row fully visible, the header still on screen.
test('expanding the parked group scrolls it into view', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 320 });
  await seedMachine(page, agent);
  await page.goto('/');
  await parkDemo(page);

  const toggle = page.getByRole('button', { name: /parked · 1/i });
  await toggle.click();

  await expect(page.locator('ul.parked .row')).toBeInViewport({ ratio: 1 });
  await expect(toggle).toBeInViewport({ ratio: 1 });
});
