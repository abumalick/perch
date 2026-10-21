import { test, expect, type Page } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';

let agent: FakeAgent;

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});

// An Android user agent attaches the Android input adapter. The engine is still WebKit, so this
// cannot stand in for a soft keyboard; it proves that hardware keys reach the real xterm and
// come out encoded, while typed text keeps going through the field.
test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' });

async function openTerminal(page: Page) {
  await seedMachine(page, agent);
  await page.goto('/');
  await page.getByText('demo', { exact: true }).click();
  await expect(page.locator('.xterm-rows').filter({ hasText: 'PERCH_READY' })).toBeVisible();
  await page.locator('.xterm-screen').click();
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
}

function inputs(): string[] {
  return agent.received
    .filter((m) => m.type === 'input')
    .map((m) => Buffer.from(String(m.data), 'base64').toString('utf8'));
}

test('hardware shortcuts reach the pty encoded, once each, around typed text', async ({ page }) => {
  await openTerminal(page);
  agent.received.length = 0;
  await page.keyboard.type('ab');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Control+p');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('c');
  await expect.poll(() => inputs().join('')).toBe('ab\x1b[1;2D\x10\x1b\t\x1b[Ac');
});

test('a keyboard-bar Ctrl applies once to the next hardware letter', async ({ page }) => {
  await openTerminal(page);
  agent.received.length = 0;
  await page.getByRole('toolbar', { name: 'Terminal keys' }).getByRole('button', { name: 'Control', exact: true }).click();
  await page.keyboard.type('pq');
  await expect.poll(() => inputs().join('')).toBe('\x10q');
});
