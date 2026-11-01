import { test, expect } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';
import { failOnCspViolation } from './csp';

failOnCspViolation(test);

let agent: FakeAgent;

const at = (id: string, name: string, lastActivityAt: number) => ({
  machineId: 'agent-machine-id',
  id,
  name,
  projectPath: `/home/u/workspace/${name}`,
  command: 'claude',
  createdAt: 1,
  lastActivityAt,
  status: 'idle',
});

test.beforeAll(async () => {
  const now = Date.now();
  agent = await startFakeAgent([
    at('perch-a1b2c3', 'source', now - 5 * 60_000),
    at('perch-d4e5f6', 'target', now - 3 * 3_600_000 - 60_000),
  ]);
});
test.afterAll(async () => {
  await agent.close();
});

test.describe('touch (iOS)', () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  });

  test('tapping a listed workspace id in the terminal opens that workspace', async ({ page }) => {
    await seedMachine(page, agent);
    await page.goto('/');
    await page.getByText('source', { exact: true }).tap();
    await expect(page.getByTestId('header-name')).toHaveText('source');
    await expect(page.locator('.xterm-rows').filter({ hasText: 'PERCH_READY perch-a1b2c3' })).toBeVisible();

    // Coloured, so each id gets its own span to tap.
    agent.sendOutput('perch-a1b2c3', 'unknown \x1b[32mperch-999999\x1b[0m\r\nspawned \x1b[32mperch-d4e5f6\x1b[0m\r\n');
    const unknown = page.locator('.xterm-rows').getByText('perch-999999', { exact: true });
    await unknown.tap();
    await expect(page.getByTestId('header-name')).toHaveText('source');

    await page.locator('.xterm-rows').getByText('perch-d4e5f6', { exact: true }).tap();
    await expect(page.getByTestId('header-name')).toHaveText('target');
    await expect(page.locator('.xterm-rows').filter({ hasText: 'PERCH_READY perch-d4e5f6' })).toBeVisible();
  });
});
