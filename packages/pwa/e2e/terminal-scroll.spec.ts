import { test, expect } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';
import { failOnCspViolation } from './csp';

failOnCspViolation(test);
test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

let agent: FakeAgent;

const mouseReports = (since: number) => agent.received.slice(since)
  .filter((message) => message.type === 'input')
  .flatMap((message) => [...Buffer.from(String(message.data), 'base64').toString()
    .matchAll(/\x1b\[<(64|65);(\d+);(\d+)M/g)]);

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});

test('touch scrolling sends mouse reports at the touched terminal cell', async ({ page }) => {
  await seedMachine(page, agent);
  await page.goto('/');
  await page.getByText('demo', { exact: true }).click();
  await expect(page.locator('.xterm-rows')).toContainText('PERCH_READY');

  agent.sendOutput('perch-demo', '\x1b[?1049h\x1b[?1003h\x1b[?1006hSCROLL_READY');
  await expect(page.locator('.xterm-rows')).toContainText('SCROLL_READY');

  for (const direction of [1, -1]) {
    const receivedBefore = agent.received.length;
    await page.locator('.xterm-screen').evaluate((screen, direction) => {
      const rect = screen.getBoundingClientRect();
      const rows = screen.querySelectorAll('.xterm-rows > div');
      const rowHeight = rows[0]!.getBoundingClientRect().height;
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rowHeight * 10.5;
      const sendTouch = (type: string, y: number | null) => {
        screen.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
          touches: y === null ? [] : [{ clientX, clientY: y }],
        }));
      };
      sendTouch('touchstart', clientY - direction * rowHeight * 1.25);
      sendTouch('touchmove', clientY);
      sendTouch('touchend', null);
    }, direction);

    await expect.poll(() => mouseReports(receivedBefore).length).toBe(2);
    for (const report of mouseReports(receivedBefore)) {
      expect(Number(report[1])).toBe(direction === 1 ? 64 : 65);
      expect(Number(report[2])).toBeGreaterThan(1);
      expect(Number(report[3])).toBe(11);
    }
  }
});

test('a swipe continues when xterm redraws the touched text span', async ({ page }) => {
  await seedMachine(page, agent);
  await page.goto('/');
  await page.getByText('demo', { exact: true }).click();
  await expect(page.locator('.xterm-rows')).toContainText('PERCH_READY');

  agent.sendOutput('perch-demo', '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[5;1HSCROLL_TARGET\x1b[20;1H');
  const text = page.locator('.xterm-rows').getByText('SCROLL_TARGET', { exact: true });
  await expect(text).toBeVisible();
  const target = (await text.elementHandle())!;
  const box = (await target.boundingBox())!;
  const rowHeight = await page.locator('.xterm-rows > div').first().evaluate(row => row.getBoundingClientRect().height);
  const receivedBefore = agent.received.length;
  const move = async (type: string, offset: number | null) => {
    await target.evaluate((element, { type, clientX, clientY }) => {
      element.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
        touches: clientY === null ? [] : [{ clientX, clientY }],
      }));
    }, { type, clientX: box.x + box.width / 2, clientY: offset === null ? null : box.y + box.height / 2 + offset });
  };

  try {
    await move('touchstart', 0);
    await move('touchmove', rowHeight * 1.25);
    await expect.poll(() => mouseReports(receivedBefore).length).toBe(2);

    agent.sendOutput('perch-demo', '\x1b[5;1HREDRAWN_TEXT\x1b[20;1H');
    await expect.poll(() => target.evaluate(element => element.isConnected)).toBe(false);

    await move('touchmove', rowHeight * 2.25);
    await expect.poll(() => mouseReports(receivedBefore).length).toBe(4);
    await move('touchend', null);
  } finally {
    await target.dispose();
  }
});
