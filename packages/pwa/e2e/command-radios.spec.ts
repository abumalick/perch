import { test, expect, type Page } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';

let agent: FakeAgent;

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});

async function openNewWorkspace(page: Page): Promise<void> {
  await seedMachine(page, agent, { defaultPath: '/home/u/workspace' });
  await page.goto('/');
  await page.getByRole('button', { name: /^new$/i }).click();
  await expect(page.getByRole('heading', { name: /new workspace/i })).toBeVisible();
}

const createButton = (page: Page) => page.getByRole('button', { name: 'Create', exact: true });

test('defaults to Claude + Opus and quotes the model flag', async ({ page }) => {
  await openNewWorkspace(page);
  await expect(page.getByRole('radio', { name: 'Claude' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Opus' })).toBeChecked();
  await page.getByTestId('path').fill('demo');
  await createButton(page).click();
  await expect
    .poll(() => agent.created.at(-1))
    .toEqual({ projectPath: '/home/u/workspace/demo', command: "claude --model 'opus[1m]'" });
});

test('selecting a Claude model passes it through --model', async ({ page }) => {
  await openNewWorkspace(page);
  await page.getByRole('radio', { name: 'Sonnet' }).click();
  await page.getByTestId('path').fill('demo');
  await createButton(page).click();
  await expect.poll(() => agent.created.at(-1)?.command).toBe("claude --model 'sonnet[1m]'");
});

test('offers only what the machine has installed, plus its remembered commands', async ({ page }) => {
  await openNewWorkspace(page);
  await expect(page.getByRole('radio', { name: 'Claude' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Codex' })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Bash' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'pi' })).toBeVisible();
});

test('a remembered command launches as typed with no model options', async ({ page }) => {
  await openNewWorkspace(page);
  await page.getByRole('radio', { name: 'pi' }).click();
  await expect(page.getByRole('radio', { name: 'Opus' })).toHaveCount(0);
  await page.getByTestId('path').fill('demo');
  await createButton(page).click();
  await expect.poll(() => agent.created.at(-1)?.command).toBe('pi');
  expect(agent.received.filter((m) => m.type === 'create').at(-1)).not.toHaveProperty('remember', true);
});

test('forgetting a remembered command removes it from the list', async ({ page }) => {
  await openNewWorkspace(page);
  const forget = page.getByRole('button', { name: 'Forget pi' });
  const badge = await forget.boundingBox();
  const chip = await page.getByRole('radio', { name: 'pi' }).locator('xpath=..').boundingBox();
  // A small circle (not a second chip) sitting on the chip's top-right corner.
  expect(badge?.width).toBe(badge?.height);
  expect(badge!.width).toBeLessThanOrEqual(24);
  expect(badge!.x + badge!.width / 2).toBeGreaterThan(chip!.x + chip!.width - 12);
  expect(badge!.y + badge!.height / 2).toBeLessThan(chip!.y + 12);
  await forget.click();
  await expect(page.getByRole('radio', { name: 'pi' })).toHaveCount(0);
});

test('selecting Bash creates a workspace running plain `bash`', async ({ page }) => {
  await openNewWorkspace(page);
  await page.getByRole('radio', { name: 'Bash' }).click();
  // Bash has no model options.
  await expect(page.getByRole('radio', { name: 'Opus' })).toHaveCount(0);
  await page.getByTestId('path').fill('demo');
  await createButton(page).click();
  await expect.poll(() => agent.created.at(-1)?.command).toBe('bash');
});

test('selecting Custom… reveals a free-text field and sends the typed command', async ({ page }) => {
  await openNewWorkspace(page);
  // The custom field is hidden until Custom… is chosen.
  await expect(page.getByTestId('custom-command')).toHaveCount(0);
  await page.getByRole('radio', { name: /custom/i }).click();
  await page.getByTestId('custom-command').fill('claude --resume');
  await page.getByTestId('path').fill('demo');
  await createButton(page).click();
  await expect.poll(() => agent.created.at(-1)?.command).toBe('claude --resume');
  expect(agent.received.filter((m) => m.type === 'create').at(-1)).toMatchObject({ remember: true });
});
