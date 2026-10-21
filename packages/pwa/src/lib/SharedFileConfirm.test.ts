import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import SharedFileConfirm from './SharedFileConfirm.svelte';

function fakeStore(over: Record<string, unknown> = {}) {
  return {
    pendingSharedFile: { name: 'photo.png', bytes: new Uint8Array(2048) },
    active: { machineId: 'mac', id: 'perch-a', name: 'fix the build' },
    statuses: { mac: 'online' },
    attachSharedFile: vi.fn(),
    discardSharedFile: vi.fn(),
    ...over,
  };
}

describe('SharedFileConfirm', () => {
  it('renders nothing without a shared file or an open workspace', () => {
    render(SharedFileConfirm, { props: { store: fakeStore({ pendingSharedFile: null }) as never } });
    expect(screen.queryByTestId('shared-file-confirm')).toBeNull();
    render(SharedFileConfirm, { props: { store: fakeStore({ active: null }) as never } });
    expect(screen.queryByTestId('shared-file-confirm')).toBeNull();
  });

  it('names the file, its size and the workspace before anything is sent', () => {
    const store = fakeStore();
    render(SharedFileConfirm, { props: { store: store as never } });
    const bar = screen.getByTestId('shared-file-confirm');
    expect(bar).toHaveTextContent('photo.png');
    expect(bar).toHaveTextContent('2.0 KB');
    expect(bar).toHaveTextContent('fix the build');
    expect(store.attachSharedFile).not.toHaveBeenCalled();
  });

  it('attaches on Attach and discards on Discard', async () => {
    const store = fakeStore();
    render(SharedFileConfirm, { props: { store: store as never } });
    await fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    expect(store.attachSharedFile).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(store.discardSharedFile).toHaveBeenCalledOnce();
  });

  it('cannot attach while the machine is offline', () => {
    render(SharedFileConfirm, { props: { store: fakeStore({ statuses: { mac: 'offline' } }) as never } });
    expect(screen.getByRole('button', { name: 'Attach' })).toBeDisabled();
  });
});
