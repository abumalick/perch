import { test, expect } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';
import { openWorkspaceMenu } from './drawer';

let agent: FakeAgent;

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});

// Marking a workspace urgent from the drawer round-trips through the agent (setUrgent →
// workspaceUpdated) and surfaces as a star marker on the list row. The within-group sort is
// unit-tested in @perch/contracts; here we cover the UI wiring end to end.
test('mark urgent from the drawer, then see the star on the list row and clear it', async ({ page }) => {
  await seedMachine(page, agent);
  await page.goto('/');

  // The `other` workspace starts idle with no star.
  const otherRow = page.locator('li', { hasText: 'other' });
  await expect(otherRow.locator('.urgent-star')).toHaveCount(0);

  await page.getByText('other', { exact: true }).click();
  await expect(page.locator('.xterm-rows').filter({ hasText: 'PERCH_READY' })).toBeVisible();

  await openWorkspaceMenu(page);
  await page.getByRole('button', { name: /mark urgent/i }).click();
  await expect(page.getByRole('button', { name: /urgent/i, pressed: true })).toBeVisible();

  // The toggle is a repeat-use action, so the drawer stays open; dismiss it before navigating.
  await page.getByRole('button', { name: 'Dismiss menu' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(otherRow.locator('.urgent-star')).toBeVisible();

  // Clearing it removes the marker again.
  await page.getByText('other', { exact: true }).click();
  await expect(page.locator('.xterm-rows').filter({ hasText: 'PERCH_READY' })).toBeVisible();
  await openWorkspaceMenu(page);
  await page.getByRole('button', { name: /urgent/i, pressed: true }).click();
  await page.getByRole('button', { name: 'Dismiss menu' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(otherRow.locator('.urgent-star')).toHaveCount(0);
});
