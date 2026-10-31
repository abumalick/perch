import { test, expect } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';

let agent: FakeAgent;

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});

// OSC 52 is how Claude Code's /copy (through tmux) reaches the terminal. WebKit refuses a
// clipboard write no tap started, so the stub refuses the first write, as iOS does, and the
// user's tap on Copy is what lands the text.
test('a program setting the clipboard is offered as a tap to copy', async ({ page }) => {
  await seedMachine(page, agent);
  await page.goto('/');
  await page.getByText('demo', { exact: true }).click();
  await expect(page.locator('.xterm-rows').filter({ hasText: 'PERCH_READY' })).toBeVisible();

  await page.evaluate(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    let calls = 0;
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: (t: string) => {
        if (calls++ === 0) return Promise.reject(new DOMException('no gesture', 'NotAllowedError'));
        w.__copied.push(t);
        return Promise.resolve();
      },
    });
  });

  const text = 'café — /copy';
  agent.sendOutput('perch-demo', `\x1b]52;;${Buffer.from(text, 'utf8').toString('base64')}\x07`);

  const offer = page.getByTestId('copy-offer');
  await expect(offer).toContainText(text);
  await offer.getByRole('button', { name: 'Copy' }).click();

  await expect(offer).toBeHidden();
  await expect(page.getByText('Copied')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([text]);
});
