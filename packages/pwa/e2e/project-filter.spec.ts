import { test, expect, type Page } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';

let agent: FakeAgent;

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});

// Seed a machine with a default path so the fake agent's two workspaces
// (/home/u/workspace/demo, /home/u/workspace/other) render as the project folders 'demo'
// and 'other' — and therefore as two filter pills.
async function seed(page: Page, agent: FakeAgent): Promise<void> {
  await seedMachine(page, agent, { defaultPath: '/home/u/workspace' });
}

test('project filter dropdown narrows the workspace list', async ({ page }) => {
  await seed(page, agent);
  await page.goto('/');

  // The workspace name lives in `.name`; the relative path also reads "demo", so scope to it.
  const rowName = (name: string) => page.locator('li .name', { hasText: name });

  // Both sessions show before any filter is applied; the control summarizes "All projects".
  await expect(rowName('demo')).toBeVisible();
  await expect(rowName('other')).toBeVisible();
  const filter = page.locator('summary[aria-label="Filter by project"]');
  await expect(filter).toContainText('All projects');

  // Open the dropdown and select the 'demo' project — the 'other' session is hidden.
  await filter.click();
  await page.getByRole('checkbox', { name: /demo/ }).check();
  await expect(rowName('demo')).toBeVisible();
  await expect(rowName('other')).toHaveCount(0);
  await expect(filter).toContainText('demo');

  // Unchecking it restores the full list.
  await page.getByRole('checkbox', { name: /demo/ }).uncheck();
  await expect(rowName('other')).toBeVisible();
  await expect(filter).toContainText('All projects');
});

test.describe('nested project folders', () => {
  let nested: FakeAgent;
  const at = (id: string, rel: string, createdAt: number) => ({
    machineId: 'agent-machine-id',
    id,
    name: id,
    projectPath: `/home/u/workspace/${rel}`,
    command: 'bash',
    createdAt,
    lastActivityAt: createdAt,
    status: 'idle',
  });

  test.beforeAll(async () => {
    nested = await startFakeAgent([
      at('baz-a', 'bar/baz', 1),
      at('qux-b', 'bar/qux/qux-content', 2),
      at('foo-c', 'foo', 3),
    ]);
  });
  test.afterAll(async () => {
    await nested.close();
  });

  test('selecting a parent folder shows every session in its subfolders', async ({ page }) => {
    await seed(page, nested);
    await page.goto('/');
    const rowName = (name: string) => page.locator('li .name', { hasText: name });
    await expect(rowName('foo-c')).toBeVisible();

    const filter = page.locator('summary[aria-label="Filter by project"]');
    await filter.click();
    await page.getByRole('checkbox', { name: /^bar\b/ }).check();
    await expect(rowName('baz-a')).toBeVisible();
    await expect(rowName('qux-b')).toBeVisible();
    await expect(rowName('foo-c')).toHaveCount(0);
    await expect(filter).toContainText('bar');
  });
});

// The tree folds a folder with a single subfolder into it (`bar/baz`), so a selection saved as
// `bar` — made while `bar` still had two subfolders — has no row of its own to untick.
test.describe('a selection on a folder the tree has folded away', () => {
  let folded: FakeAgent;
  const at = (id: string, rel: string, createdAt: number) => ({
    machineId: 'agent-machine-id',
    id,
    name: id,
    projectPath: `/home/u/workspace/${rel}`,
    command: 'bash',
    createdAt,
    lastActivityAt: createdAt,
    status: 'idle',
  });

  test.beforeAll(async () => {
    folded = await startFakeAgent([at('baz-a', 'bar/baz', 1), at('foo-c', 'foo', 2)]);
  });
  test.afterAll(async () => {
    await folded.close();
  });

  test('it keeps its own row, and the clear button lifts it from the closed control', async ({ page }) => {
    await seed(page, folded);
    await page.addInitScript(() => localStorage.setItem('perch.folderFilter', JSON.stringify(['bar'])));
    await page.goto('/');
    const rowName = (name: string) => page.locator('li .name', { hasText: name });
    const filter = page.locator('summary[aria-label="Filter by project"]');
    await expect(rowName('baz-a')).toBeVisible();
    await expect(rowName('foo-c')).toHaveCount(0);
    await expect(filter).toContainText('Only bar');

    // The folded folder keeps a checked row of its own, so unticking it works too.
    await filter.click();
    await expect(page.getByRole('checkbox', { name: /^bar\b/ })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /^baz\b/ })).not.toBeChecked();
    await page.getByRole('button', { name: 'Close project filter' }).click();

    await page.getByRole('button', { name: 'Clear project filter' }).click();
    await expect(filter).toContainText('All projects');
    await expect(rowName('foo-c')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear project filter' })).toHaveCount(0);
  });
});

test('hide mode drops the selected project and survives a reload', async ({ page }) => {
  await seed(page, agent);
  await page.goto('/');

  const rowName = (name: string) => page.locator('li .name', { hasText: name });
  const filter = page.locator('summary[aria-label="Filter by project"]');
  await expect(rowName('demo')).toBeVisible();

  // Switch the control to Hide and drop 'demo' — the inverse of the show-only path.
  await filter.click();
  await page.getByRole('radio', { name: 'Hide' }).click();
  await page.getByRole('checkbox', { name: /demo/ }).check();
  await expect(rowName('demo')).toHaveCount(0);
  await expect(rowName('other')).toBeVisible();
  await expect(filter).toContainText('Hiding demo');

  // Both the mode and the hidden set are persisted, so a reload comes back filtered.
  await page.reload();
  await expect(rowName('other')).toBeVisible();
  await expect(rowName('demo')).toHaveCount(0);
  await expect(filter).toContainText('Hiding demo');

  // Hiding every project empties the list — which must say so rather than show nothing.
  await filter.click();
  await page.getByRole('checkbox', { name: /other/ }).check();
  // The open menu floats over the list, so close it the way a tap outside would before
  // reaching for the recovery button underneath.
  await page.getByRole('button', { name: 'Close project filter' }).click();
  await expect(page.getByTestId('home-all-filtered')).toContainText('2 sessions hidden');
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(rowName('demo')).toBeVisible();
  await expect(rowName('other')).toBeVisible();
});

test('the show-only selection survives a trip through hide mode', async ({ page }) => {
  await seed(page, agent);
  await page.goto('/');

  const filter = page.locator('summary[aria-label="Filter by project"]');
  await filter.click();
  await page.getByRole('checkbox', { name: /demo/ }).check();
  await expect(filter).toContainText('Only demo');

  // Flipping to Hide and back must not have discarded the show-only pick.
  await page.getByRole('radio', { name: 'Hide' }).click();
  await expect(filter).toContainText('All projects');
  await page.getByRole('radio', { name: 'Show only' }).click();
  await expect(filter).toContainText('Only demo');
});
