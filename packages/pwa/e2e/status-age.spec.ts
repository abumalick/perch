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

test('a home row shows how long its workspace has held its status', async ({ page }) => {
  await seedMachine(page, agent);
  await page.goto('/');
  const row = (name: string) => page.locator('.row').filter({ has: page.locator('.name', { hasText: name }) });
  await expect(row('target').getByTestId('status-age')).toHaveText('for 3h');
  await expect(row('source').getByTestId('status-age')).toHaveText('for 5m');
});

