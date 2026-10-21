import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { generateAgentKeys } from '@perch/secure-channel';
import MachineDetail from './MachineDetail.svelte';

const KEY = generateAgentKeys().x25519.publicKey;
const OTHER_KEY = generateAgentKeys().x25519.publicKey;

type Machine = { id: string; name: string; url: string; token?: string; agentKey?: string; defaultPath?: string; enabled?: boolean };

function setup(machine: Partial<Machine> = {}, overrides: Record<string, unknown> = {}) {
  const store = {
    statuses: {} as Record<string, string>,
    lastConnectionError: {} as Record<string, { message: string; code?: number; at: number }>,
    updateMachine: vi.fn(),
    removeMachine: vi.fn(),
    reconnectMachine: vi.fn(),
    ...overrides,
  };
  const onClose = vi.fn();
  const m: Machine = { id: 'mac', name: 'Mac', url: 'wss://relay/acct', token: 't', agentKey: KEY, ...machine };
  render(MachineDetail, { props: { store: store as never, machine: m as never, onClose } });
  return { store, onClose };
}

describe('MachineDetail', () => {
  it('names the machine and goes back to the list', async () => {
    const { onClose } = setup();
    expect(screen.getByRole('heading', { name: 'Mac' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('pre-fills the default path, url, an empty token and the agent key', () => {
    setup({ defaultPath: '/home/u/ws' });
    expect((screen.getByTestId('edit-default-path') as HTMLInputElement).value).toBe('/home/u/ws');
    expect((screen.getByTestId('edit-url') as HTMLInputElement).value).toBe('wss://relay/acct');
    expect((screen.getByTestId('edit-token') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('edit-agent-key') as HTMLInputElement).value).toBe(KEY);
  });

  it('saves an edited default path and returns to the list', async () => {
    const { store, onClose } = setup();
    await fireEvent.input(screen.getByTestId('edit-default-path'), { target: { value: '/new/root' } });
    await fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(store.updateMachine).toHaveBeenCalledWith('mac', {
      url: 'wss://relay/acct',
      token: undefined,
      defaultPath: '/new/root',
      agentKey: undefined,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('saves an edited url and token', async () => {
    const { store } = setup();
    await fireEvent.input(screen.getByTestId('edit-url'), { target: { value: 'wss://mac2' } });
    await fireEvent.input(screen.getByTestId('edit-token'), { target: { value: 'newtok' } });
    await fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(store.updateMachine).toHaveBeenCalledWith('mac', { url: 'wss://mac2', token: 'newtok', defaultPath: undefined, agentKey: undefined });
  });

  it('sends the agent key only when it changed', async () => {
    const { store } = setup();
    await fireEvent.input(screen.getByTestId('edit-agent-key'), { target: { value: ` ${OTHER_KEY} ` } });
    await fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(store.updateMachine).toHaveBeenLastCalledWith('mac', { url: 'wss://relay/acct', token: undefined, defaultPath: undefined, agentKey: OTHER_KEY });
  });

  it.each([
    ['a malformed', 'not-a-key'],
    ['an empty', ''],
  ])('refuses to save %s agent key', async (_label, value) => {
    const { store, onClose } = setup();
    await fireEvent.input(screen.getByTestId('edit-agent-key'), { target: { value } });
    await fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(store.updateMachine).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/agent key/i);
  });

  it('does not save an empty url', async () => {
    const { store } = setup();
    await fireEvent.input(screen.getByTestId('edit-url'), { target: { value: '' } });
    await fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(store.updateMachine).not.toHaveBeenCalled();
  });

  it('shows the connection error and reconnects a machine that is not online', async () => {
    const { store } = setup({}, {
      statuses: { mac: 'offline' },
      lastConnectionError: { mac: { message: 'relay unreachable', code: 1006, at: Date.now() } },
    });
    expect(screen.getByTestId('diagnostic')).toHaveTextContent('relay unreachable (code 1006)');
    await fireEvent.click(screen.getByTestId('reconnect'));
    expect(store.reconnectMachine).toHaveBeenCalledWith('mac');
  });

  it('offers no reconnect for an online or switched-off machine', () => {
    setup({ enabled: false }, { statuses: { mac: 'offline' } });
    expect(screen.queryByTestId('reconnect')).toBeNull();
  });

  describe('removing', () => {
    it('asks first, naming the machine, and does nothing until confirmed', async () => {
      const { store } = setup();
      await fireEvent.click(screen.getByRole('button', { name: /remove machine/i }));
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Remove Mac?');
      expect(dialog).toHaveTextContent('perch pair');
      expect(store.removeMachine).not.toHaveBeenCalled();
    });

    it('removes on confirm and leaves the detail page', async () => {
      const { store, onClose } = setup();
      await fireEvent.click(screen.getByRole('button', { name: /remove machine/i }));
      await fireEvent.click(screen.getByRole('button', { name: 'Remove Mac' }));
      expect(store.removeMachine).toHaveBeenCalledWith('mac');
      expect(onClose).toHaveBeenCalled();
    });

    it('keeps the machine on Cancel', async () => {
      const { store } = setup();
      await fireEvent.click(screen.getByRole('button', { name: /remove machine/i }));
      await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(store.removeMachine).not.toHaveBeenCalled();
    });
  });
});
