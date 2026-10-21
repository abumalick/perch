import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { generateAgentKeys } from '@perch/secure-channel';
import AddMachine from './AddMachine.svelte';

function fakeStore(overrides: Record<string, unknown> = {}) {
  return {
    addMachine: vi.fn(),
    goSettings: vi.fn(),
    ...overrides,
  };
}

const KEY = generateAgentKeys().x25519.publicKey;

async function fillRequired(name: string, url: string): Promise<void> {
  await fireEvent.input(screen.getByLabelText(/name/i), { target: { value: name } });
  await fireEvent.input(screen.getByLabelText(/url/i), { target: { value: url } });
  await fireEvent.input(screen.getByLabelText(/token/i), { target: { value: 'sek' } });
}

describe('AddMachine', () => {
  it('adds a relay machine with the agent key it pins, and returns to settings', async () => {
    const store = fakeStore();
    render(AddMachine, { props: { store: store as never } });
    await fillRequired('Mini PC', 'wss://relay/acct');
    await fireEvent.input(screen.getByLabelText(/agent key/i), { target: { value: ` ${KEY} ` } });
    await fireEvent.click(screen.getByRole('button', { name: /add machine/i }));
    expect(store.addMachine).toHaveBeenCalledWith({
      id: 'mini-pc',
      name: 'Mini PC',
      url: 'wss://relay/acct',
      token: 'sek',
      agentKey: KEY,
    });
    expect(store.goSettings).toHaveBeenCalled();
  });

  it('adds a machine with an optional default path', async () => {
    const store = fakeStore();
    render(AddMachine, { props: { store: store as never } });
    await fillRequired('Mini PC', 'wss://relay/acct');
    await fireEvent.input(screen.getByLabelText(/agent key/i), { target: { value: KEY } });
    await fireEvent.input(screen.getByLabelText(/default path/i), { target: { value: '/home/u/ws' } });
    await fireEvent.click(screen.getByRole('button', { name: /add machine/i }));
    expect(store.addMachine).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: '/home/u/ws', agentKey: KEY }));
  });

  it.each([
    ['no', ''],
    ['a malformed', 'not-a-key'],
  ])('refuses a machine with %s agent key, and says why', async (_label, key) => {
    const store = fakeStore();
    render(AddMachine, { props: { store: store as never } });
    await fillRequired('Dev', 'wss://relay/acct');
    await fireEvent.input(screen.getByLabelText(/agent key/i), { target: { value: key } });
    await fireEvent.click(screen.getByRole('button', { name: /add machine/i }));
    expect(store.addMachine).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/agent key/i);
  });

  it('offers no way to add a machine outside the relay', () => {
    render(AddMachine, { props: { store: fakeStore() as never } });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByLabelText(/agent key/i)).toBeInTheDocument();
  });

  it('does not add a machine when a required field is missing', async () => {
    const store = fakeStore();
    render(AddMachine, { props: { store: store as never } });
    await fireEvent.input(screen.getByLabelText(/name/i), { target: { value: 'Mini PC' } });
    await fireEvent.click(screen.getByRole('button', { name: /add machine/i }));
    expect(store.addMachine).not.toHaveBeenCalled();
    expect(store.goSettings).not.toHaveBeenCalled();
  });

  it('returns to settings via the back button without adding', async () => {
    const store = fakeStore();
    render(AddMachine, { props: { store: store as never } });
    await fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(store.goSettings).toHaveBeenCalled();
    expect(store.addMachine).not.toHaveBeenCalled();
  });
});
