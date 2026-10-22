import { test, expect } from '@playwright/test';
import { seedMachine, startFakeAgent } from './fake-agent';

// A machine being online says nothing about its workspaces until its reply to `list` arrives:
// the home screen keeps the loader until then, and offers to create a workspace only once the
// machine has really answered with none.

test('keeps the loader until an empty workspace list arrives, then offers to create one', async ({ page }) => {
  const agent = await startFakeAgent([]);
  try {
    const release = agent.holdList();
    await seedMachine(page, agent);
    await page.goto('/');

    // The load strip comes from the `stats` the agent sends beside its `list` reply: the
    // session is up and only the workspace list is outstanding.
    await expect(page.getByTestId('machine-load')).toBeVisible();
    await expect(page.getByTestId('home-connecting')).toBeVisible();
    await expect(page.getByTestId('home-create')).toHaveCount(0);

    release();
    await expect(page.getByTestId('home-create')).toBeVisible();
    await expect(page.getByTestId('home-connecting')).toHaveCount(0);
  } finally {
    await agent.close();
  }
});

test('goes from the loader straight to the list, never through the create prompt', async ({ page }) => {
  const agent = await startFakeAgent();
  try {
    const release = agent.holdList();
    await seedMachine(page, agent);
    // Record every time the create prompt enters the DOM, however briefly.
    await page.addInitScript(() => {
      const w = window as unknown as { createSeen: number };
      w.createSeen = 0;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="home-create"]')) w.createSeen += 1;
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto('/');

    await expect(page.getByTestId('machine-load')).toBeVisible();
    await expect(page.getByTestId('home-connecting')).toBeVisible();

    release();
    await expect(page.getByText('demo', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { createSeen: number }).createSeen)).toBe(0);
  } finally {
    await agent.close();
  }
});
