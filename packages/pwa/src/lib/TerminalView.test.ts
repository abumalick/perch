import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import type { CommandEntry } from '@perch/contracts';

const writes: string[] = [];
const pasted: string[] = [];
const loadedAddons: unknown[] = [];
let dataCb: (d: string) => void = () => undefined;
let keyHandler: (e: KeyboardEvent) => boolean = () => true;
let focusCount = 0;
let blurCount = 0;
let lastTerminalOptions: Record<string, unknown> | null = null;
let resetCount = 0;
let selectionText = '';
let bufferRows: string[] = [];
let oscHandlers: Record<number, (data: string) => boolean> = {};

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) { this.options = { ...opts }; lastTerminalOptions = this.options; }
    loadAddon(addon: unknown) { loadedAddons.push(addon); }
    textarea?: HTMLTextAreaElement;
    // Like xterm, open() puts its hidden textarea inside the container.
    open(el: HTMLElement) { this.textarea = document.createElement('textarea'); el.appendChild(this.textarea); }
    write(d: string) { writes.push(d); }
    paste(d: string) { pasted.push(d); }
    onData(cb: (d: string) => void) { dataCb = cb; }
    attachCustomKeyEventHandler(cb: (e: KeyboardEvent) => boolean) { keyHandler = cb; }
    onResize() {}
    parser = { registerOscHandler: (id: number, cb: (data: string) => boolean) => { oscHandlers[id] = cb; } };
    dispose() {}
    reset() { resetCount += 1; }
    focus() { focusCount += 1; }
    blur() { blurCount += 1; }
    hasSelection() { return selectionText.length > 0; }
    getSelection() { return selectionText; }
    clearSelection() { selectionText = ''; }
    get buffer() {
      return {
        active: {
          viewportY: 0,
          length: bufferRows.length,
          getLine: (y: number) =>
            bufferRows[y] === undefined
              ? undefined
              : { isWrapped: false, translateToString: () => bufferRows[y] },
        },
      };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
let webLinksHandler: ((e: unknown, uri: string) => void) | undefined;
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(handler?: (e: unknown, uri: string) => void) {
      webLinksHandler = handler;
    }
  },
}));
vi.mock('./terminal-link', () => ({
  isIOSWebKit: vi.fn(() => false),
  openTerminalLink: vi.fn(),
}));
// Spy on isAndroid so a test can force the Android path; keep the real implementation
// (jsdom's UA → false) as the default for every other test.
vi.mock('./android-input', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./android-input')>();
  return { ...actual, isAndroid: vi.fn(actual.isAndroid) };
});

import { WebLinksAddon } from '@xterm/addon-web-links';
import { isIOSWebKit, openTerminalLink } from './terminal-link';
import { isAndroid } from './android-input';
import TerminalView from './TerminalView.svelte';

const AGENT_KEY = 'A'.repeat(42) + 'Q';

function fakeStore(
  autoFocus = false,
  terminalFontSize = 13,
  machines: { id: string; name: string; defaultPath?: string }[] = [{ id: 'mac', name: 'Mac' }],
) {
  return {
    machines: machines.map((m) => ({ agentKey: AGENT_KEY, ...m })),
    active: { machineId: 'mac', id: 'perch-a', name: 'api', projectPath: '/home/u/workspace/perch', command: 'claude', createdAt: 0, lastActivityAt: 0, status: 'idle' as const },
    terminalState: 'live' as const,
    autoFocus,
    terminalFontSize,
    shareLinks: false,
    openPairingLink: vi.fn((uri: string) => uri.includes('#pair?')),
    onOutput: null as ((d: string) => void) | null,
    attach: vi.fn(),
    sendInput: vi.fn(),
    resize: vi.fn(),
    back: vi.fn(),
    closeActive: vi.fn(),
    openBrowser: vi.fn(),
    setTerminalFontSize: vi.fn(),
    setWorkspaceStatus: vi.fn(),
    browserSessionsFor: vi.fn(() => [] as string[]),
    supportsBrowser: vi.fn(() => false),
    machineCommands: {} as Record<string, CommandEntry[]>,
    openBrowserView: vi.fn(),
    startBrowser: vi.fn(),
  };
}

describe('TerminalView', () => {
  // On a phone (jsdom has no matchMedia → trackWide reports not-wide) the overflow
  // controls live in the drawer, so open it before interacting with them.
  const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Menu' }));

  beforeEach(() => {
    focusCount = 0;
    blurCount = 0;
    resetCount = 0;
    selectionText = '';
    bufferRows = [];
    oscHandlers = {};
    loadedAddons.length = 0;
    pasted.length = 0;
    webLinksHandler = undefined;
    vi.mocked(openTerminalLink).mockClear();
    vi.mocked(isIOSWebKit).mockClear();
    vi.mocked(isAndroid).mockReturnValue(false);
  });

  it('focuses the terminal on mount only when autoFocus is set', () => {
    render(TerminalView, { props: { store: fakeStore(false) as never } });
    expect(focusCount).toBe(0);
    render(TerminalView, { props: { store: fakeStore(true) as never } });
    expect(focusCount).toBe(1);
  });

  // The drop-down offers the shortcuts of the machine the active workspace lives on, and
  // picking one writes to that workspace's pty.
  it('offers the active machine command shortcuts and sends the picked one', async () => {
    const store = fakeStore();
    store.machineCommands = { mac: [{ command: '/rename', submit: true }] };
    render(TerminalView, { props: { store: store as never } });
    await fireEvent.click(screen.getByRole('button', { name: /commands/i }));
    await fireEvent.click(screen.getByRole('option', { name: '/rename' }));
    expect(store.sendInput).toHaveBeenCalledWith('/rename\r');
  });

  it('hides the commands trigger when the active machine has no shortcuts', () => {
    const store = fakeStore();
    store.machineCommands = { other: [{ command: '/rename', submit: true }] };
    render(TerminalView, { props: { store: store as never } });
    expect(screen.queryByRole('button', { name: /commands/i })).toBeNull();
  });

  it('attaches on mount and wires output + input + buttons', async () => {
    const store = fakeStore();
    render(TerminalView, { props: { store: store as never } });
    expect(store.attach).toHaveBeenCalled();
    // output sink registered → term.write receives decoded data
    store.onOutput?.('hello');
    expect(writes).toContain('hello');
    // input flows from xterm to store
    dataCb('ls\n');
    expect(store.sendInput).toHaveBeenCalledWith('ls\n');
    await fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(store.back).toHaveBeenCalled();
    await openMenu();
    await fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(store.closeActive).toHaveBeenCalled();
  });

  it('sets a new status from the drawer status picker', async () => {
    const store = fakeStore();
    render(TerminalView, { props: { store: store as never } });
    await openMenu();
    await fireEvent.click(screen.getByRole('button', { name: /status: idle/i }));
    // Choosing a status from the picker routes through the store.
    await fireEvent.click(screen.getByRole('option', { name: /blocked/i }));
    expect(store.setWorkspaceStatus).toHaveBeenCalledWith('blocked');
  });

  it('names a child waiting on its orchestrator in the drawer status picker', async () => {
    const store = fakeStore();
    store.active = { ...store.active, status: 'working' as never, waitingOn: 'parent' } as never;
    render(TerminalView, { props: { store: store as never } });
    await openMenu();
    expect(screen.getByRole('button', { name: /status: needs orchestrator/i })).toBeTruthy();
  });

  it('maps a hardware ⌘/⌥ chord to its sequence and swallows the event', () => {
    const store = fakeStore();
    render(TerminalView, { props: { store: store as never } });

    let prevented = false;
    const handled = keyHandler({
      type: 'keydown',
      key: 'ArrowLeft',
      metaKey: true,
      altKey: false,
      preventDefault: () => { prevented = true; },
    } as unknown as KeyboardEvent);

    expect(handled).toBe(false);
    expect(prevented).toBe(true);
    expect(store.sendInput).toHaveBeenCalledWith('\x01');
  });

  it('passes plain keydowns through to xterm untouched', () => {
    const store = fakeStore();
    render(TerminalView, { props: { store: store as never } });

    const handled = keyHandler({
      type: 'keydown',
      key: 'a',
      metaKey: false,
      altKey: false,
      preventDefault: () => undefined,
    } as unknown as KeyboardEvent);

    expect(handled).toBe(true);
    expect(store.sendInput).not.toHaveBeenCalled();
  });

  it('refreshes by resetting the terminal and re-attaching', async () => {
    const store = fakeStore();
    render(TerminalView, { props: { store: store as never } });
    // mount attaches once; refresh resets the wedged display and re-attaches.
    expect(store.attach).toHaveBeenCalledTimes(1);
    expect(resetCount).toBe(0);
    await openMenu();
    await fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(resetCount).toBe(1);
    expect(store.attach).toHaveBeenCalledTimes(2);
    expect(store.attach).toHaveBeenLastCalledWith(80, 24);
  });

  it('opens the browser view from the drawer when the workspace has a single session', async () => {
    const store = fakeStore();
    store.browserSessionsFor = vi.fn(() => ['perch-a']);
    render(TerminalView, { props: { store: store as never } });
    await openMenu();
    await fireEvent.click(screen.getByRole('button', { name: /^browser$/i }));
    expect(store.openBrowserView).toHaveBeenCalledWith('mac', 'perch-a');
  });

  it('drops a menu instead of opening a session when the workspace has several', async () => {
    const store = fakeStore();
    store.browserSessionsFor = vi.fn(() => ['perch-a', 'perch-a__login']);
    render(TerminalView, { props: { store: store as never } });
    await openMenu();
    // The trigger drops a menu (labels the bare session "main" and the prefixed one "login").
    await fireEvent.click(screen.getByRole('button', { name: /browser \(2\)/i }));
    expect(store.openBrowserView).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('menuitem', { name: /login/i }));
    expect(store.openBrowserView).toHaveBeenCalledWith('mac', 'perch-a__login');
  });

  it('offers Start browser in the drawer when the agent supports it and no session exists', async () => {
    const store = fakeStore();
    store.supportsBrowser = vi.fn(() => true);
    render(TerminalView, { props: { store: store as never } });
    await openMenu();
    await fireEvent.click(screen.getByRole('button', { name: /start browser/i }));
    expect(store.startBrowser).toHaveBeenCalledWith('mac', 'perch-a');
  });

  it('shows no browser action in the drawer when the agent never reported browser support', async () => {
    render(TerminalView, { props: { store: fakeStore() as never } });
    await openMenu();
    expect(screen.queryByRole('button', { name: /browser/i })).toBeNull();
  });

  it('opens the file browser from the drawer', async () => {
    const store = fakeStore();
    render(TerminalView, { props: { store: store as never } });
    await openMenu();
    await fireEvent.click(screen.getByRole('button', { name: /files/i }));
    expect(store.openBrowser).toHaveBeenCalled();
  });

  it('shows the project above the workspace name, shortened against the machine root', () => {
    render(TerminalView, {
      props: { store: fakeStore(false, 13, [{ id: 'mac', name: 'Mac', defaultPath: '/home/u/workspace' }]) as never },
    });
    expect(screen.getByTestId('header-project').textContent).toBe('perch');
    expect(screen.getByTestId('header-name').textContent).toBe('api');
  });

  it('names the machine only when more than one machine is connectable', () => {
    const { unmount } = render(TerminalView, { props: { store: fakeStore() as never } });
    expect(screen.queryByTestId('header-machine')).toBeNull();
    unmount();
    render(TerminalView, {
      props: { store: fakeStore(false, 13, [{ id: 'mac', name: 'Mac' }, { id: 'dev', name: 'Dev' }]) as never },
    });
    expect(screen.getByTestId('header-machine').textContent).toBe('Mac');
  });

  it('keeps the phone header minimal: overflow controls hide until the menu opens', async () => {
    render(TerminalView, { props: { store: fakeStore() as never } });
    // Back stays in the header; everything else waits behind the drawer.
    expect(screen.getByRole('button', { name: /back/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /files/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^close$/i })).toBeNull();
    await openMenu();
    expect(screen.getByRole('button', { name: /files/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /refresh/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^close$/i })).toBeTruthy();
  });

  it('no longer renders the on-terminal scroll buttons', () => {
    render(TerminalView, { props: { store: fakeStore() as never } });
    expect(screen.queryByRole('button', { name: /scroll up/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /scroll down/i })).toBeNull();
  });

  it('loads the web-links addon so URLs are tappable', () => {
    render(TerminalView, { props: { store: fakeStore() as never } });
    expect(loadedAddons.some((a) => a instanceof WebLinksAddon)).toBe(true);
  });

  it('routes OSC 8 hyperlinks through openTerminalLink with the detected platform', () => {
    vi.mocked(isIOSWebKit).mockReturnValue(true);
    render(TerminalView, { props: { store: fakeStore() as never } });
    const handler = lastTerminalOptions?.linkHandler as
      | { activate?: (e: unknown, uri: string) => void }
      | undefined;
    expect(handler?.activate).toBeTypeOf('function');
    handler!.activate!(new MouseEvent('click'), 'https://example.com');
    expect(openTerminalLink).toHaveBeenCalledWith('https://example.com', { ios: true, share: false });
  });

  it('routes plain-text URLs (web-links addon) through the same openTerminalLink path', () => {
    vi.mocked(isIOSWebKit).mockReturnValue(false);
    render(TerminalView, { props: { store: fakeStore() as never } });
    expect(webLinksHandler).toBeTypeOf('function');
    webLinksHandler!(new MouseEvent('click'), 'https://plain.example');
    expect(openTerminalLink).toHaveBeenCalledWith('https://plain.example', { ios: false, share: false });
  });

  it('passes the share-links preference to openTerminalLink at the time of the tap', () => {
    const store = fakeStore();
    render(TerminalView, { props: { store: store as never } });
    store.shareLinks = true;
    webLinksHandler!(new MouseEvent('click'), 'https://plain.example');
    expect(openTerminalLink).toHaveBeenCalledWith('https://plain.example', { ios: false, share: true });
  });

  // Opened, a pairing link would pair in another page context of the app, behind this one.
  it('hands a pairing link to the running app instead of opening it, from either link path', () => {
    const store = fakeStore();
    render(TerminalView, { props: { store: store as never } });
    const handler = lastTerminalOptions?.linkHandler as { activate: (e: unknown, uri: string) => void };
    handler.activate(new MouseEvent('click'), 'https://pwa.example/#pair?u=a');
    webLinksHandler!(new MouseEvent('click'), 'https://pwa.example/#pair?u=b');
    expect(store.openPairingLink.mock.calls.map(([uri]) => uri)).toEqual(['https://pwa.example/#pair?u=a', 'https://pwa.example/#pair?u=b']);
    expect(openTerminalLink).not.toHaveBeenCalled();
  });

  it('pastes clipboard text into the terminal from the keyboard bar', async () => {
    const readText = vi.fn().mockResolvedValue('echo hi');
    Object.assign(navigator, { clipboard: { readText } });
    render(TerminalView, { props: { store: fakeStore() as never } });
    await fireEvent.click(screen.getByRole('button', { name: /paste/i }));
    await vi.waitFor(() => expect(pasted).toContain('echo hi'));
  });

  it('zooms in and out by one step through the drawer font controls', async () => {
    const store = fakeStore(false, 13);
    render(TerminalView, { props: { store: store as never } });
    await openMenu();
    await fireEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    expect(store.setTerminalFontSize).toHaveBeenCalledWith(14);
    await fireEvent.click(screen.getByRole('button', { name: /zoom out/i }));
    expect(store.setTerminalFontSize).toHaveBeenCalledWith(12);
  });

  it('disables zoom in at the maximum font size', async () => {
    render(TerminalView, { props: { store: fakeStore(false, 24) as never } });
    await openMenu();
    expect(screen.getByRole('button', { name: /zoom in/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /zoom out/i })).not.toBeDisabled();
  });

  it('disables zoom out at the minimum font size', async () => {
    render(TerminalView, { props: { store: fakeStore(false, 8) as never } });
    await openMenu();
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /zoom in/i })).not.toBeDisabled();
  });

  it('initializes the terminal at the store font size', () => {
    render(TerminalView, { props: { store: fakeStore(false, 17) as never } });
    expect(lastTerminalOptions?.fontSize).toBe(17);
  });

  it('enables ⌥-drag force-selection so copy-on-select works in a mouse-mode session', () => {
    render(TerminalView, { props: { store: fakeStore() as never } });
    expect(lastTerminalOptions?.macOptionClickForcesSelection).toBe(true);
  });

  it('copies the selection to the clipboard on a mouse pointer-up, showing a toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    selectionText = 'grabbed text';
    const { container } = render(TerminalView, { props: { store: fakeStore() as never } });

    const term = container.querySelector('.term')!;
    await fireEvent(
      term,
      Object.assign(new Event('pointerup', { bubbles: true }), { pointerType: 'mouse' }),
    );

    expect(writeText).toHaveBeenCalledWith('grabbed text');
    await screen.findByText('Copied');
  });

  it('copies text a program sends with OSC 52 straight away when the browser allows it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(TerminalView, { props: { store: fakeStore() as never } });

    expect(oscHandlers[52]?.(`c;${btoa('from /copy')}`)).toBe(true);

    await screen.findByText('Copied');
    expect(writeText).toHaveBeenCalledWith('from /copy');
    expect(screen.queryByTestId('copy-offer')).toBeNull();
  });

  it('offers a tap to copy when the browser refuses a write without a gesture', async () => {
    const refused = new DOMException('no gesture', 'NotAllowedError');
    const writeText = vi.fn().mockRejectedValueOnce(refused).mockRejectedValueOnce(refused);
    writeText.mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(TerminalView, { props: { store: fakeStore() as never } });

    oscHandlers[52]!(`c;${btoa('first')}`);
    oscHandlers[52]!(`c;${btoa('latest copy')}`);

    const offer = await screen.findByTestId('copy-offer');
    expect(offer.textContent).toContain('latest copy');
    expect(offer.textContent).not.toContain('first');
    await fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenLastCalledWith('latest copy');
    await screen.findByText('Copied');
    expect(screen.queryByTestId('copy-offer')).toBeNull();
  });

  it('does not let an older refused copy replace a newer one that succeeded', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new DOMException('no gesture', 'NotAllowedError'));
    writeText.mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(TerminalView, { props: { store: fakeStore() as never } });

    oscHandlers[52]!(`c;${btoa('older')}`);
    oscHandlers[52]!(`c;${btoa('newer')}`);

    await screen.findByText('Copied');
    await Promise.resolve();
    expect(screen.queryByTestId('copy-offer')).toBeNull();
  });

  it('dismisses the copy offer without copying', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('no gesture', 'NotAllowedError'));
    Object.assign(navigator, { clipboard: { writeText } });
    render(TerminalView, { props: { store: fakeStore() as never } });

    oscHandlers[52]!(`c;${btoa('secret')}`);
    await screen.findByTestId('copy-offer');
    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByTestId('copy-offer')).toBeNull();
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('does not copy on a touch pointer-up (desktop-only behaviour)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    selectionText = 'grabbed text';
    const { container } = render(TerminalView, { props: { store: fakeStore() as never } });

    const term = container.querySelector('.term')!;
    await fireEvent(
      term,
      Object.assign(new Event('pointerup', { bubbles: true }), { pointerType: 'touch' }),
    );

    expect(writeText).not.toHaveBeenCalled();
  });

  it('select mode shows the buffer as a plain-text snapshot, and removes it when toggled off', async () => {
    bufferRows = ['$ echo hi', 'hi', ''];
    const { container } = render(TerminalView, { props: { store: fakeStore() as never } });
    const toggle = screen.getByRole('button', { name: /select text/i });
    expect(container.querySelector('.snapshot')).toBeNull();

    await fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const lines = [...container.querySelectorAll('.snapshot .line')].map((l) => l.textContent);
    expect(lines).toEqual(['$ echo hi', 'hi']);

    await fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelector('.snapshot')).toBeNull();
  });

  it('takes the snapshot the moment select mode opens, so later output cannot disturb a selection', async () => {
    bufferRows = ['before'];
    const { container } = render(TerminalView, { props: { store: fakeStore() as never } });
    await fireEvent.click(screen.getByRole('button', { name: /select text/i }));
    bufferRows = ['after'];
    expect(container.querySelector('.snapshot')!.textContent).toBe('before');
  });

  it('copies a snapshot selection without the indent its lines share', async () => {
    bufferRows = ['  - item', '    continued'];
    const { container } = render(TerminalView, { props: { store: fakeStore() as never } });
    await fireEvent.click(screen.getByRole('button', { name: /select text/i }));
    const snapshot = container.querySelector('.snapshot')!;
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => '  - item\n    continued' } as Selection);
    const setData = vi.fn();
    const copy = Object.assign(new Event('copy', { bubbles: true, cancelable: true }), { clipboardData: { setData } });
    snapshot.dispatchEvent(copy);
    expect(setData).toHaveBeenCalledWith('text/plain', '- item\n  continued');
    expect(copy.defaultPrevented).toBe(true);
    vi.mocked(window.getSelection).mockRestore();
  });

  it('clears any xterm selection on entering select mode, so copy-on-select cannot re-copy it', async () => {
    selectionText = 'stale';
    render(TerminalView, { props: { store: fakeStore() as never } });
    await fireEvent.click(screen.getByRole('button', { name: /select text/i }));
    expect(selectionText).toBe('');
  });

  it('blurs the terminal when select mode turns on and refocuses when it turns off', async () => {
    // With the hidden textarea focused (keyboard up), iOS/iPadOS routes a long-press into
    // the field and never starts a selection on the rows; blurring on select-on dismisses
    // the keyboard so native long-press selection works. Refocus on select-off restores typing.
    render(TerminalView, { props: { store: fakeStore() as never } });
    const toggle = screen.getByRole('button', { name: /select text/i });
    expect(blurCount).toBe(0);

    await fireEvent.click(toggle);
    expect(blurCount).toBe(1);
    expect(focusCount).toBe(0);

    await fireEvent.click(toggle);
    expect(focusCount).toBe(1);
  });

  // On Android a hardware letter reaches the pty through the adapter's field, so an armed
  // keyboard-bar Ctrl turns it into a control byte the field does not hold: the field must start
  // over, or the next edit would be diffed against a letter the pty never got.
  it('applies an armed bar Ctrl once to a key typed into the Android field', async () => {
    vi.mocked(isAndroid).mockReturnValue(true);
    const store = fakeStore();
    const { container } = render(TerminalView, { props: { store: store as never } });
    const textarea = container.querySelector('textarea')!;
    const input = (value: string, data: string) => {
      textarea.value = value;
      textarea.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data, bubbles: true }));
    };
    await fireEvent.click(screen.getByRole('button', { name: 'Control' }));
    input('p', 'p');
    expect(store.sendInput).toHaveBeenLastCalledWith('\x10');
    expect(textarea.value).toBe('');
    input('x', 'x');
    expect(store.sendInput).toHaveBeenLastCalledWith('x');
    expect(store.sendInput).toHaveBeenCalledTimes(2);
  });

  // The Blink-only RTL fix is gated behind this class so it can't touch WebKit's already
  // correct rendering. jsdom has no bidi/layout engine, so this guards the gating only —
  // the visual result is verified on-device.
  it('gates the RTL fix behind an .android class on the terminal container', () => {
    vi.mocked(isAndroid).mockReturnValue(true);
    const { container } = render(TerminalView, { props: { store: fakeStore() as never } });
    expect(container.querySelector('.term')!.classList.contains('android')).toBe(true);
  });

  it('omits the .android class on non-Android', () => {
    const { container } = render(TerminalView, { props: { store: fakeStore() as never } });
    expect(container.querySelector('.term')!.classList.contains('android')).toBe(false);
  });
});
