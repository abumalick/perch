import { afterEach, describe, it, expect, vi } from 'vitest';
import { tick } from 'svelte';
import { setLanguage } from '../i18n.svelte';
import { render, screen, fireEvent, within } from '@testing-library/svelte';
import { generateAgentKeys } from '@tarfa/secure-channel';
import Settings from './Settings.svelte';

import { inputLog } from '../core/terminal-input-log';
import { DEFAULT_PRESETS } from '../core/dictation-presets';

const KEY = generateAgentKeys().x25519.publicKey;

function fakeStore(overrides: Record<string, unknown> = {}) {
  return {
    machines: [{ id: 'mac', name: 'Mac', addresses: ['wss://mac'], token: 't', agentKey: KEY }] as Record<string, unknown>[],
    statuses: {} as Record<string, string>,
    lastConnectionError: {} as Record<string, { message: string; code?: number; at: number }>,
    addMachine: vi.fn(),
    updateMachine: vi.fn(),
    removeMachine: vi.fn(),
    reconnectMachine: vi.fn(),
    toggleMachine: vi.fn(),
    replaceDeviceKey: vi.fn(),
    pairFromLink: vi.fn(() => ({ error: 'nope' })),
    back: vi.fn(),
    goNewMachine: vi.fn(),
    elevenLabsApiKey: '',
    setElevenLabsApiKey: vi.fn(),
    openRouterApiKey: '',
    setOpenRouterApiKey: vi.fn(),
    dictationPresets: [...DEFAULT_PRESETS],
    saveDictationPresets: vi.fn(),
    resetDictationPresets: vi.fn(),
    shareLinks: false,
    setShareLinks: vi.fn(),
    languageChoice: 'auto',
    setLanguageChoice: vi.fn(),
    ...overrides,
  };
}

describe('Settings — machines list', () => {
  it('returns home via the Back button', async () => {
    const store = fakeStore();
    render(Settings, { props: { store: store as never } });
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(store.back).toHaveBeenCalled();
  });

  it('shows each machine with its status, and no way to remove it from the list', () => {
    const store = fakeStore({ statuses: { mac: 'online' } });
    render(Settings, { props: { store: store as never } });
    const mac = screen.getByRole('button', { name: /^Mac/ });
    expect(mac).toHaveTextContent('Online');
    expect(within(mac.closest('ul')!).queryByRole('button', { name: /remove|delete/i })).toBeNull();
  });

  it("shows each machine's first address, and how many more it has", () => {
    const store = fakeStore({
      machines: [
        { id: 'a', name: 'Cloud box', addresses: ['wss://cloud.example.com/'], token: 't', agentKey: KEY },
        { id: 'b', name: 'Home box', addresses: ['wss://box.example.ts.net:10000/abu', 'wss://box.example.ts.net:8443/abu'], token: 't', agentKey: KEY },
      ],
    });
    render(Settings, { props: { store: store as never } });
    const [cloudHost, homeHost] = screen.getAllByTestId('machine-host');
    expect(cloudHost?.parentElement).toHaveTextContent(/^Cloud box\s*cloud\.example\.com$/);
    expect(homeHost).toHaveTextContent(/^box\.example\.ts\.net:10000 \+1$/);
  });

  it('opens the machine detail on tap, and comes back', async () => {
    const store = fakeStore();
    render(Settings, { props: { store: store as never } });
    await fireEvent.click(screen.getByRole('button', { name: /^Mac/ }));
    expect(screen.getByRole('heading', { name: 'Mac' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove machine/i })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(store.back).not.toHaveBeenCalled();
  });

  it('toggles a machine from its row', async () => {
    const store = fakeStore({ statuses: { mac: 'online' } });
    render(Settings, { props: { store: store as never } });
    const sw = screen.getByRole('switch', { name: /connect mac/i });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await fireEvent.click(sw);
    expect(store.toggleMachine).toHaveBeenCalledWith('mac');
  });

  it('shows a switched-off machine as Off, with no error', () => {
    const store = fakeStore({
      machines: [{ id: 'mac', name: 'Mac', addresses: ['wss://mac'], agentKey: KEY, enabled: false }],
      statuses: { mac: 'offline' },
      lastConnectionError: { mac: { message: 'old error', code: 1006, at: Date.now() } },
    });
    render(Settings, { props: { store: store as never } });
    expect(screen.getByRole('button', { name: /^Mac/ })).toHaveTextContent('Off');
    expect(screen.queryByTestId('diagnostic')).toBeNull();
    expect(screen.getByRole('switch', { name: /connect mac/i }).getAttribute('aria-checked')).toBe('false');
  });

  it('shows why an offline machine is not connected', () => {
    const store = fakeStore({
      statuses: { mac: 'offline' },
      lastConnectionError: { mac: { message: 'machine unreachable', code: 1006, at: Date.now() } },
    });
    render(Settings, { props: { store: store as never } });
    expect(screen.getByTestId('diagnostic')).toHaveTextContent('machine unreachable (code 1006)');
  });

  it('hides an old error once the machine is online', () => {
    const store = fakeStore({
      statuses: { mac: 'online' },
      lastConnectionError: { mac: { message: 'old error', code: 1006, at: Date.now() } },
    });
    render(Settings, { props: { store: store as never } });
    expect(screen.queryByTestId('diagnostic')).toBeNull();
  });

});

describe('Settings — adding a machine', () => {
  it('keeps the pairing options folded away behind Add machine once a machine exists', async () => {
    const store = fakeStore();
    render(Settings, { props: { store: store as never } });
    expect(screen.queryByTestId('pair-machine')).toBeNull();
    const add = screen.getByRole('button', { name: 'Add machine' });
    expect(add.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(add);
    expect(screen.getByTestId('pair-machine')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /enter details by hand/i }));
    expect(store.goNewMachine).toHaveBeenCalled();
  });

  it('shows the pairing options straight away when there is no machine yet', () => {
    render(Settings, { props: { store: fakeStore({ machines: [] }) as never } });
    expect(screen.getByTestId('pair-machine')).toBeInTheDocument();
  });
});

describe('Settings — dictation', () => {
  it('pre-fills the ElevenLabs API key field from the store', () => {
    render(Settings, { props: { store: fakeStore({ elevenLabsApiKey: 'sk_existing' }) as never } });
    expect((screen.getByLabelText(/elevenlabs api key/i) as HTMLInputElement).value).toBe('sk_existing');
  });

  it('saves the key and says so', async () => {
    const store = fakeStore();
    render(Settings, { props: { store: store as never } });
    await fireEvent.input(screen.getByLabelText(/elevenlabs api key/i), { target: { value: 'sk_new' } });
    await fireEvent.click(screen.getAllByRole('button', { name: /save key/i })[0]!);
    expect(store.setElevenLabsApiKey).toHaveBeenCalledWith('sk_new');
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
  });

  it('saves the OpenRouter key and says where recordings go', async () => {
    const store = fakeStore({ openRouterApiKey: 'sk-or-old' });
    render(Settings, { props: { store: store as never } });
    const field = screen.getByLabelText(/openrouter api key/i) as HTMLInputElement;
    expect(field.value).toBe('sk-or-old');
    expect(screen.getByText(/Recordings sent with an OpenRouter preset go to OpenRouter and the model's provider/)).toBeInTheDocument();
    await fireEvent.input(field, { target: { value: 'sk-or-new' } });
    await fireEvent.click(screen.getAllByRole('button', { name: /save key/i })[1]!);
    expect(store.setOpenRouterApiKey).toHaveBeenCalledWith('sk-or-new');
  });

  it('lists the dictation presets', () => {
    render(Settings, { props: { store: fakeStore() as never } });
    expect(screen.getByRole('button', { name: /Edit Clean up/ })).toBeInTheDocument();
  });
});

describe('Settings — device key and diagnostics', () => {
  it('shows this device key fingerprint and where it is kept, to match against tarfa devices', () => {
    const store = fakeStore({ deviceKey: { fingerprint: 'a1b2-c3d4-e5f6', storage: { x25519: 'webcrypto', ed25519: 'noble' } } });
    render(Settings, { props: { store: store as never } });
    expect(screen.getByTestId('device-key')).toHaveTextContent(
      'Device key a1b2-c3d4-e5f6 · X25519 in WebCrypto (non-extractable) · Ed25519 stored key',
    );
  });

  it('says why a key is a stored key when WebCrypto was tried and failed', () => {
    const store = fakeStore({
      deviceKey: {
        fingerprint: 'a1b2-c3d4-e5f6',
        storage: { x25519: 'noble', ed25519: 'noble' },
        fallback: { x25519: 'WebCrypto key could not be stored: DataCloneError: no', ed25519: 'WebCrypto key could not be stored: DataCloneError: no' },
      },
    });
    render(Settings, { props: { store: store as never } });
    expect(screen.getByTestId('device-key')).toHaveTextContent(
      'X25519 stored key (WebCrypto key could not be stored: DataCloneError: no) · Ed25519 stored key (WebCrypto key could not be stored: DataCloneError: no)',
    );
  });

  it('puts a device key problem at the top, with its way out', async () => {
    const store = fakeStore({ deviceKey: null, deviceKeyError: 'IndexedDB unavailable: UnknownError: gone', deviceKeyUnreadable: true });
    render(Settings, { props: { store: store as never } });
    expect(screen.getByTestId('device-key')).toHaveTextContent('Device key unavailable: IndexedDB unavailable: UnknownError: gone');
    await fireEvent.click(screen.getByRole('button', { name: 'Make a new device key' }));
    expect(store.replaceDeviceKey).toHaveBeenCalled();
  });

  it('shows a live viewport readout under diagnostics', () => {
    render(Settings, { props: { store: fakeStore() as never } });
    expect(screen.getByTestId('viewport')).toHaveTextContent(/Viewport:\s*\d+\s*×\s*\d+\s*·\s*DPR/);
  });

  it('shows the terminal input log and reflects it on Refresh', async () => {
    inputLog.clear();
    inputLog.push({ kind: 'compositionupdate', detail: 'gi', out: 'i' });
    render(Settings, { props: { store: fakeStore() as never } });
    await fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    const panel = screen.getByTestId('input-log');
    expect(panel.textContent).toContain('compositionupdate');
    expect(panel.textContent).toContain('gi');
  });

  it('clears the terminal input log', async () => {
    inputLog.clear();
    inputLog.push({ kind: 'keydown', detail: 'a (65)', out: '' });
    render(Settings, { props: { store: fakeStore() as never } });
    await fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(inputLog.snapshot()).toEqual([]);
    expect(screen.getByTestId('input-log').textContent).toContain('Android IME events only');
  });
});

describe('Settings — terminal links', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('on Android, offers opening terminal links with the share sheet', async () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (Linux; Android 16) Chrome/155', share: vi.fn() });
    const store = fakeStore();
    render(Settings, { props: { store: store as never } });
    await fireEvent.click(screen.getByRole('switch', { name: /share sheet/i }));
    expect(store.setShareLinks).toHaveBeenCalledWith(true);
  });

  it('elsewhere, does not offer it', () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', share: vi.fn() });
    render(Settings, { props: { store: fakeStore() as never } });
    expect(screen.queryByRole('switch', { name: /share sheet/i })).toBeNull();
  });
});

describe('Settings — language', () => {
  afterEach(() => setLanguage('en'));

  it('offers Auto, English and French, and saves the pick', async () => {
    const store = fakeStore();
    render(Settings, { props: { store: store as never } });
    const select = screen.getByLabelText('Language') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['auto', 'en', 'fr']);
    await fireEvent.change(select, { target: { value: 'fr' } });
    expect(store.setLanguageChoice).toHaveBeenCalledWith('fr');
  });

  it('redraws in French at once when the language changes', async () => {
    render(Settings, { props: { store: fakeStore() as never } });
    expect(screen.getByLabelText('Language')).toBeTruthy();
    setLanguage('fr');
    await tick();
    expect(screen.getByLabelText('Langue')).toBeTruthy();
  });
});

describe('Settings in French', () => {
  afterEach(() => setLanguage('en'));

  it('titles the page in French', () => {
    setLanguage('fr');
    render(Settings, { props: { store: fakeStore() as never } });
    expect(screen.getByRole('heading', { name: 'Réglages' })).toBeTruthy();
  });
});
