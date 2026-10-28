import { test, expect, type Page } from '@playwright/test';
import { seedMachine, startFakeAgent, type FakeAgent } from './fake-agent';

let agent: FakeAgent;

test.beforeAll(async () => {
  agent = await startFakeAgent();
});
test.afterAll(async () => {
  await agent.close();
});

// The keyboard bar's sticky modifiers against a soft keyboard. WebKit has no IME, so each
// keyboard edit is replayed as the event sequence HeliBoard produced on a Galaxy Tab
// (captured over Chrome DevTools); the browser's part, applying the edit to the field, is
// done by hand. Everything after that is the real terminal view and the real bar.
test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-X135) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' });

type Step =
  | { word: string } // a word typed (or swiped) as one composition
  | { phantomSpace: true } // the space a keyboard owes after a swiped word or a picked suggestion
  | { bar: string }; // a keyboard-bar button, by its accessible name or label

async function openTerminal(page: Page) {
  await seedMachine(page, agent);
  await page.goto('/');
  await page.getByText('demo', { exact: true }).click();
  await expect(page.locator('.xterm-rows').filter({ hasText: 'PERCH_READY' })).toBeVisible();
  await page.locator('.xterm-screen').click();
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
}

function inputs(): string {
  return agent.received
    .filter((m) => m.type === 'input')
    .map((m) => Buffer.from(String(m.data), 'base64').toString('utf8'))
    .join('');
}

async function softKeyboard(page: Page, step: { word: string } | { phantomSpace: true }) {
  await page.evaluate((s) => {
    const ta = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
    const fire = (e: Event) => ta.dispatchEvent(e);
    const key229 = () => fire(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }));
    const apply = (text: string) => {
      ta.value += text;
      ta.setSelectionRange(ta.value.length, ta.value.length);
    };
    if ('phantomSpace' in s) {
      key229();
      fire(new InputEvent('beforeinput', { inputType: 'insertText', data: ' ', bubbles: true, cancelable: true }));
      apply(' ');
      fire(new InputEvent('input', { inputType: 'insertText', data: ' ', bubbles: true }));
      return;
    }
    key229();
    fire(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    fire(new CompositionEvent('compositionupdate', { data: s.word, bubbles: true }));
    fire(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data: s.word, isComposing: true, bubbles: true, cancelable: true }));
    apply(s.word);
    fire(new InputEvent('input', { inputType: 'insertCompositionText', data: s.word, isComposing: true, bubbles: true }));
    fire(new CompositionEvent('compositionend', { data: s.word, bubbles: true }));
  }, step);
}

async function run(page: Page, steps: Step[]) {
  const bar = page.getByRole('toolbar', { name: 'Terminal keys' });
  for (const step of steps) {
    if ('bar' in step) await bar.getByRole('button', { name: step.bar, exact: true }).click();
    else await softKeyboard(page, step);
  }
}

const cases: { name: string; steps: Step[]; bytes: string }[] = [
  { name: '⌥ + a typed letter', steps: [{ bar: 'Option' }, { word: 'b' }], bytes: '\x1bb' },
  { name: '⌃ + a typed letter', steps: [{ bar: 'Control' }, { word: 'c' }], bytes: '\x03' },
  { name: 'a typed letter after ⌥ is used up', steps: [{ bar: 'Option' }, { word: 'b' }, { word: 'b' }], bytes: '\x1bbb' },
  { name: 'a locked ⌥ applies to every letter', steps: [{ bar: 'Option' }, { bar: 'Option' }, { word: 'b' }, { word: 'f' }], bytes: '\x1bb\x1bf' },
  {
    name: '⌥ + a letter after a swiped word (phantom space)',
    steps: [{ word: 'hello' }, { bar: 'Option' }, { phantomSpace: true }, { word: 'b' }],
    bytes: 'hello \x1bb',
  },
  {
    name: '⌃ + a letter after a swiped word (phantom space)',
    steps: [{ word: 'hello' }, { bar: 'Control' }, { phantomSpace: true }, { word: 'c' }],
    bytes: 'hello \x03',
  },
  { name: '⌃ + the bar ␣', steps: [{ bar: 'Control' }, { bar: '␣' }], bytes: '\x00' },
  { name: '⌥ + the bar ␣', steps: [{ bar: 'Option' }, { bar: '␣' }], bytes: '\x1b ' },
  { name: '⌥ + the bar ⌫', steps: [{ bar: 'Option' }, { bar: '⌫' }], bytes: '\x1b\x7f' },
  { name: '⌘ + the bar ⌫', steps: [{ bar: 'Command' }, { bar: '⌫' }], bytes: '\x15' },
];

for (const c of cases) {
  test(`${c.name} reaches the pty as the exact bytes`, async ({ page }) => {
    await openTerminal(page);
    agent.received.length = 0;
    await run(page, c.steps);
    await expect.poll(inputs).toBe(c.bytes);
  });
}
