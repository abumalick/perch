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

// A portrait tablet (601px wide) has room for the status beside the title, so the header
// carries it and the drawer drops it; a phone keeps it in the drawer.
for (const { width, inHeader } of [
  { width: 601, inHeader: true },
  { width: 390, inHeader: false },
]) {
  test(`at ${width}px the status picker is ${inHeader ? 'in the header' : 'in the drawer'}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await seedMachine(page, agent);
    await page.goto('/');

    await page.locator('button.row', { hasText: 'demo' }).first().click();
    await expect(page.locator('.xterm-rows').filter({ hasText: 'PERCH_READY' })).toBeVisible();

    const header = page.locator('.terminal-screen header');
    await expect(header.getByRole('button', { name: /status:/i })).toHaveCount(inHeader ? 1 : 0);
    await expect(page.getByTestId('header-name')).toBeVisible();

    await page.getByRole('button', { name: 'Menu' }).click();
    const drawer = page.getByRole('dialog', { name: 'Workspace actions' });
    await expect(drawer.getByRole('button', { name: 'Files' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: /status:/i })).toHaveCount(inHeader ? 0 : 1);
  });
}

// "Next" walks the sessions that may need the user without going back to the list: in the
// header from 601px, in the drawer on a phone. demo needs you, other is idle; it cycles.
for (const { width, inHeader } of [
  { width: 601, inHeader: true },
  { width: 390, inHeader: false },
]) {
  test(`at ${width}px Next opens the next workspace from the ${inHeader ? 'header' : 'drawer'}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await seedMachine(page, agent);
    await page.goto('/');

    await page.locator('button.row', { hasText: 'demo' }).first().click();
    await expect(page.getByTestId('header-name')).toHaveText('demo');

    const next = async () => {
      if (inHeader) await page.locator('.terminal-screen header').getByRole('button', { name: 'Next workspace' }).click();
      else {
        await page.getByRole('button', { name: 'Menu' }).click();
        await page.getByRole('dialog', { name: 'Workspace actions' }).getByRole('button', { name: 'Next workspace' }).click();
      }
    };
    await next();
    await expect(page.getByTestId('header-name')).toHaveText('other');
    await expect(page.locator('.xterm-rows').filter({ hasText: 'PERCH_READY perch-other' })).toBeVisible();
    await next();
    await expect(page.getByTestId('header-name')).toHaveText('demo');
  });
}
