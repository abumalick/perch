import { test, expect } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';

let agent: FakeAgent;

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});

// The workspace name alone does not say which project a terminal belongs to, so the header
// carries the project on a line above it, shortened against the machine's root like the list.
test('the terminal header names the project above the workspace', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedMachine(page, agent, { defaultPath: '/home/u/workspace' });
  await page.goto('/');

  await page.locator('button.row', { hasText: 'demo' }).first().click();
  await expect(page.locator('.xterm-rows').filter({ hasText: 'PERCH_READY' })).toBeVisible();

  await expect(page.getByTestId('header-project')).toHaveText('demo');
  await expect(page.getByTestId('header-name')).toHaveText('demo');
  await expect(page.getByTestId('header-machine')).toHaveCount(0);
  if (process.env.HEADER_SHOT) await page.locator('.terminal-screen header').screenshot({ path: process.env.HEADER_SHOT });
});
