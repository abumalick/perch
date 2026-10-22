import { test, expect, type Page } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';

let agent: FakeAgent;

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});

test.use({ viewport: { width: 390, height: 844 } });

async function openTerminal(page: Page) {
  await page.goto('/');
  await page.getByText('demo', { exact: true }).click();
  await expect(page.locator('.xterm-rows').filter({ hasText: 'PERCH_READY' })).toBeVisible();
}

function mic(page: Page) {
  return page.getByRole('toolbar', { name: 'Terminal keys' }).getByRole('button', { name: /^Dictate/ });
}

// Hold the mic past the long-press threshold with a real pointer, as a finger would.
async function holdMic(page: Page) {
  const box = (await mic(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
}

test('the mic shows the current preset, and a long press opens the presets on screen', async ({ page }) => {
  await seedMachine(page, agent);
  await openTerminal(page);
  await expect(mic(page)).toHaveAccessibleName('Dictate (Scribe)');
  await expect(mic(page)).toContainText('EL');

  await holdMic(page);
  const menu = page.getByRole('listbox', { name: 'Dictation presets' });
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(menu.getByRole('option', { name: /Clean up/ })).toContainText('needs key');
  // The press ended when the menu opened, though the finger lifted over the backdrop.
  await expect(mic(page)).not.toHaveClass(/pressed/);
});

test('picking a preset changes the badge and survives a reload', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('perch.openRouterApiKey', 'sk-or-test'));
  await seedMachine(page, agent);
  await openTerminal(page);

  await holdMic(page);
  await page.getByRole('option', { name: /Clean up/ }).click();
  await expect(page.getByRole('listbox', { name: 'Dictation presets' })).toHaveCount(0);
  await expect(mic(page)).toHaveAccessibleName('Dictate (Clean up)');
  await expect(mic(page)).toContainText('CL');

  await openTerminal(page);
  await expect(mic(page)).toContainText('CL');
});
