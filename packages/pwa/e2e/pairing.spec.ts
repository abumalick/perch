import { test, expect, type Page } from '@playwright/test';
import { pairingLink } from '@perch/secure-channel';
import { startFakeAgent, type FakeAgent } from './fake-agent';
import { failOnCspViolation } from './csp';

failOnCspViolation(test);

// A pairing link carries a one-time secret in its fragment. Opening it (or pasting it) adds the
// relay entry and connects with the secret in place of a token; the secret must never reach a
// request, stay in the address bar, or outlive the machine accepting it.

let agent: FakeAgent;
// A fresh code per test, minted on the agent as `perch pair` does: the first use spends it.
let SECRET: string;

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});
test.beforeEach(async () => {
  agent.received.length = 0;
  agent.upgrades = 0;
  SECRET = await agent.newPairing();
});

function link(origin: string, defaultPath?: string): string {
  return pairingLink(origin, { url: agent.url, agentKey: agent.agentKey, secret: SECRET, name: 'dev box', defaultPath });
}

function recordUrls(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  page.on('websocket', (socket) => urls.push(socket.url()));
  return urls;
}

const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('perch.machines') ?? '[]') as Array<Record<string, unknown>>);

test('opening a pairing link adds the machine, connects with the secret, and forgets it', async ({ page, baseURL }) => {
  const urls = recordUrls(page);
  const asked: string[] = [];
  page.on('dialog', (dialog) => {
    asked.push(dialog.message());
    void dialog.accept();
  });
  await page.goto(link(baseURL!));
  await expect(page.getByText('demo', { exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(asked).toEqual([expect.stringContaining('Pair with dev box through 127.0.0.1')]);
  expect(agent.received.find((m) => m.type === 'auth')).toEqual({ type: 'auth', token: SECRET });
  await expect.poll(async () => (await stored(page))[0]?.pairing).toBeUndefined();
  expect(await stored(page)).toEqual([expect.objectContaining({ name: 'dev box', token: '', agentKey: agent.agentKey })]);
  expect(urls.filter((url) => url.includes(SECRET))).toEqual([]);
  expect(await page.evaluate(() => history.length)).toBeGreaterThan(0);

  // Reconnecting later carries no secret and no token: the enrolled device key is the credential.
  agent.received.length = 0;
  await page.reload();
  await expect(page.getByText('demo', { exact: true })).toBeVisible();
  expect(agent.received.find((m) => m.type === 'auth')).toEqual({ type: 'auth', token: '' });
});

test('a pairing link opened from elsewhere adds nothing unless the owner confirms it', async ({ page, baseURL }) => {
  page.on('dialog', (dialog) => void dialog.dismiss());
  await page.goto(link(baseURL!));
  await expect(page.getByText('No machines yet')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(await stored(page)).toEqual([]);
  await page.waitForTimeout(300);
  expect(agent.received.filter((m) => m.type === 'auth' && m.token === SECRET)).toEqual([]);
});

test('pasting a pairing link in Settings pairs too, on a phone', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /add a machine/i }).click();
  await page.getByLabel(/paste a pairing link/i).fill(link(baseURL!));
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByText('demo', { exact: true })).toBeVisible();
  expect(agent.received.find((m) => m.type === 'auth')).toEqual({ type: 'auth', token: SECRET });
});

test("a pairing link carrying the machine's default path sets it on the new entry", async ({ page, baseURL }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /add a machine/i }).click();
  await page.getByLabel(/paste a pairing link/i).fill(link(baseURL!, '/home/u/workspace'));
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByText('demo', { exact: true }).first()).toBeVisible();
  // Still there once enrolment has spent the secret and rewritten the entry.
  await expect.poll(async () => (await stored(page))[0]?.pairing).toBeUndefined();
  expect(await stored(page)).toEqual([expect.objectContaining({ defaultPath: '/home/u/workspace' })]);
});

test('a pasted link that is not a pairing link is refused with a reason', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /add a machine/i }).click();
  await page.getByLabel(/paste a pairing link/i).fill('https://example.com/#pair?u=nope');
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('not a Perch pairing code');
  expect(await stored(page)).toEqual([]);
});

// The relay refuses a phone in band: a browser's WebSocket reports 1006 for any refused upgrade,
// so the reason can only reach the phone as a close code and reason on an opened socket.
for (const [state, message] of [
  ['expired', 'This pairing code has expired — run `perch pair` on dev box for a new one'],
  ['used', 'This pairing code was already used — run `perch pair` on dev box for a new one'],
] as const) {
  test(`a refused pairing code says so on the home screen and in Settings: ${state}`, async ({ page, baseURL }) => {
    SECRET = await agent.newPairing(state);
    page.on('dialog', (dialog) => void dialog.accept());
    await page.goto(link(baseURL!));
    await expect(page.getByTestId('home-refusal')).toHaveText(message);
    await expect(page.getByText(/tailscale/i)).toHaveCount(0);
    await page.getByRole('button', { name: /settings/i }).first().click();
    await expect(page.getByTestId('diagnostic')).toContainText(message);
    await expect(page.getByTestId('diagnostic')).not.toContainText('1006');
    await expect(page.getByTestId('diagnostic')).not.toContainText('code 4403');
    // A final refusal is not redialed: the next attempt waits for the owner.
    const upgrades = agent.upgrades;
    await page.waitForTimeout(1500);
    expect(agent.upgrades).toBe(upgrades);
    expect((await stored(page))[0]?.pairing).toBe(SECRET);
  });
}

test('a pairing link tapped inside the app pairs in place, without opening another page', async ({ page, baseURL, context }) => {
  const opened: string[] = [];
  context.on('page', (other) => opened.push(other.url()));
  const asked: string[] = [];
  page.on('dialog', (dialog) => {
    asked.push(dialog.message());
    void dialog.accept();
  });
  await page.goto('/');
  await expect(page.getByText('No machines yet')).toBeVisible();
  // What the terminal's link handler does on Android: an anchor with target=_blank, clicked.
  await page.evaluate((href) => {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
  }, link(baseURL!));
  await expect(page.getByText('demo', { exact: true })).toBeVisible();
  expect(asked).toEqual([expect.stringContaining('Pair with dev box')]);
  expect(opened).toEqual([]);
});

test('an entry paired in another window of the app appears here without a reload', async ({ page, baseURL, context }) => {
  await page.goto('/');
  await expect(page.getByText('No machines yet')).toBeVisible();
  const other = await context.newPage();
  other.on('dialog', (dialog) => void dialog.accept());
  await other.goto(link(baseURL!));
  await expect(other.getByText('demo', { exact: true })).toBeVisible();
  await expect(page.getByText('demo', { exact: true })).toBeVisible();
});

// iOS keeps the Home Screen app's storage apart from Safari's and from in-app browsers, and no
// link opens the Home Screen app, so a link opened there is held unspent for the owner to carry over.
test('on iOS outside the Home Screen app, a pairing link waits to be carried into the app', async ({ page, baseURL }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => false }));
  const asked: string[] = [];
  page.on('dialog', (dialog) => {
    asked.push(dialog.message());
    void dialog.accept();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(link(baseURL!));
  await expect(page.getByRole('heading', { name: 'Pair dev box from the Home Screen app' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(await stored(page)).toEqual([]);
  await page.waitForTimeout(300);
  expect(agent.received.filter((m) => m.type === 'auth')).toEqual([]);
  expect(asked).toEqual([]);

  await page.getByRole('button', { name: /pair in this browser instead/i }).click();
  await expect(page.getByText('demo', { exact: true })).toBeVisible();
  expect(asked).toEqual([expect.stringContaining('Pair with dev box')]);
  expect(agent.received.find((m) => m.type === 'auth')).toEqual({ type: 'auth', token: SECRET });
});
