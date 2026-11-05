import { test, expect } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';
import { failOnCspViolation } from './csp';

failOnCspViolation(test);

// An entry tries its addresses in order: one that cannot be reached hands over to the next.

let agent: FakeAgent;

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});

test('an entry whose first address is a closed port connects through its second', async ({ page }) => {
  await seedMachine(page, agent, { addresses: ['ws://127.0.0.1:59995/', agent.url] });
  await page.goto('/');
  await expect(page.getByText('demo', { exact: true })).toBeVisible();
});
