import { test, expect, type Page } from '@playwright/test';
import { machineEntry, seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';

let agent: FakeAgent;

// A workspace whose name is far longer than a phone screen. The row's `.name` ellipsizes,
// but only if every flex/grid ancestor can shrink — a missing `min-width: 0` on `.name-line`
// lets the name push the row past the viewport and the whole page scrolls sideways.
test.beforeAll(async () => {
  agent = await startFakeAgent([
    {
      machineId: 'agent-machine-id',
      id: 'perch-long',
      name: 'a-very-long-workspace-session-name-that-keeps-going-and-going-forever',
      projectPath: '/home/u/workspace/a/deeply/nested/and/quite/long/project/path/here',
      command: 'bash',
      createdAt: 1,
      lastActivityAt: 1,
      status: 'needs-feedback',
    },
  ]);
});
test.afterAll(async () => {
  await agent.close();
});

async function seed(page: Page, agent: FakeAgent): Promise<void> {
  await seedMachine(page, agent, { defaultPath: '/home/u/workspace' });
}

// iPhone-class viewport: the single-pane mobile layout (wide sidebar kicks in at ≥1024px).
test.use({ viewport: { width: 390, height: 844 } });

test('workspace list does not scroll horizontally with a long-named session', async ({ page }) => {
  await seed(page, agent);
  await page.goto('/');

  await expect(page.locator('li .name')).toBeVisible();

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});

// The busiest rows a phone shows: two machines (so each row carries a machine pill), a child
// waiting on its orchestrator ("Needs orchestrator") with an agent address, and the status age.
test.describe('crowded rows', () => {
  let dev: FakeAgent;
  let mac: FakeAgent;
  const at = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    machineId: 'agent-machine-id',
    id,
    name: `${id}-a-name-long-enough-to-need-its-ellipsis`,
    projectPath: '/home/u/workspace/a/deeply/nested/project',
    command: 'claude',
    createdAt: 1,
    lastActivityAt: Date.now() - 15 * 3_600_000,
    status,
    ...extra,
  });

  test.beforeAll(async () => {
    dev = await startFakeAgent([
      at('perch-0aaaaa', 'working', { agentAddress: 'perch-1e' }),
      at('perch-226a82', 'working', { agentAddress: 'perch-226a82', parentId: 'perch-0aaaaa', waitingOn: 'parent' }),
      at('perch-3ccccc', 'working', { agentAddress: 'perch-226a83', waitingOn: 'parent' }),
    ]);
    mac = await startFakeAgent([at('perch-4ddddd', 'idle')]);
  });
  test.afterAll(async () => {
    await dev.close();
    await mac.close();
  });

  test('no row and no page overflows', async ({ page }) => {
    await page.addInitScript(
      (entries) => localStorage.setItem('perch.machines', JSON.stringify(entries)),
      [machineEntry(dev, { id: 'dev', name: 'dev' }), machineEntry(mac, { id: 'mac', name: 'mac' })],
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Show 1 child workspace' }).click();
    await expect(page.locator('ul.children .row')).toHaveCount(1);
    await expect(page.locator('.row')).toHaveCount(4);
    await expect(page.locator('.row .badge', { hasText: 'Needs orchestrator' })).toHaveCount(2);

    const overflowing = await page.evaluate(() =>
      [...document.querySelectorAll('.row .path-line, .row .name-line')]
        .filter((line) => line.scrollWidth > line.clientWidth)
        .map((line) => `${line.closest('.row')?.querySelector('.name')?.textContent}: ${line.className}`),
    );
    expect(overflowing).toEqual([]);
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
