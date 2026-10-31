import { test, expect } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';

let agent: FakeAgent;

const at = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  machineId: 'agent-machine-id',
  id,
  name: id.replace('perch-', ''),
  projectPath: '/home/u/workspace/demo',
  command: 'claude',
  createdAt: 1,
  lastActivityAt: 1,
  status,
  ...extra,
});

// A working orchestrator with one child asking a question and one waiting on it: the parent
// sorts with its most urgent child, ahead of an idle workspace.
test.beforeAll(async () => {
  agent = await startFakeAgent([
    at('perch-other', 'idle'),
    at('perch-orchestrator', 'working'),
    at('perch-asks', 'needs-feedback', { parentId: 'perch-orchestrator' }),
    at('perch-waits', 'working', { parentId: 'perch-orchestrator', waitingOn: 'parent' }),
  ]);
});
test.afterAll(async () => {
  await agent.close();
});

test.use({ viewport: { width: 390, height: 844 } });

test('children fold under their orchestrator and expand indented', async ({ page }) => {
  await seedMachine(page, agent);
  await page.goto('/');

  const rowNames = page.locator('.row .name');
  await expect(rowNames).toHaveText(['orchestrator', 'other']);

  const toggle = page.getByRole('button', { name: 'Show 2 child workspaces' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toContainText('⧉ 2');

  await toggle.click();
  await expect(rowNames).toHaveText(['orchestrator', 'asks', 'waits', 'other']);
  await expect(page.locator('ul.children .row .name')).toHaveText(['asks', 'waits']);
  await expect(page.getByRole('button', { name: 'Hide 2 child workspaces' })).toHaveAttribute('aria-expanded', 'true');
  // Tapping the toggle did not open the orchestrator.
  await expect(page.locator('.xterm-rows')).toHaveCount(0);

  const parentBox = (await page.locator('.parent > .row').boundingBox())!;
  const childBox = (await page.locator('ul.children .row').first().boundingBox())!;
  expect(childBox.x).toBeGreaterThan(parentBox.x);

  const waits = page.locator('.row').filter({ hasText: 'waits' });
  await expect(waits.locator('.badge')).toHaveText('Needs orchestrator');

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

  // The fold lives in the store, so opening a child and coming back keeps it open.
  await page.locator('ul.children').getByText('asks', { exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hide 2 child workspaces' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('ul.children .row .name')).toHaveText(['asks', 'waits']);
});
