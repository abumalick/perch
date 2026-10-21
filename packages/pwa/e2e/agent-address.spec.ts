import { test, expect } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';

let agent: FakeAgent;

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});

// This covers the one seam the unit tests structurally cannot: the field has to survive the
// zod parse on the way in. The schema strips unknown keys, so an omission there deletes an
// agent-sent field silently — green unit tests on both sides, no badge in the browser.
// The `demo` workspace carries an address from the fake agent; `other` carries none.
test('a workspace shows the agent address its agent sent, and none when there is none', async ({
  page,
}) => {
  await seedMachine(page, agent);
  await page.goto('/');

  const demoRow = page.locator('li', { hasText: 'demo' }).first();
  await expect(demoRow.getByTestId('agent-address')).toHaveText('demo-7f');

  const otherRow = page.locator('li', { hasText: 'other' }).first();
  await expect(otherRow.getByTestId('agent-address')).toHaveCount(0);
});
