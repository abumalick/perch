import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import InstallFirst from './InstallFirst.svelte';

const LINK = 'https://p/#pair?x';

function fakeStore() {
  return { installFirst: { name: 'dev box', link: LINK }, pairInBrowser: vi.fn() };
}

describe('InstallFirst', () => {
  it('names the machine and says the code is still unused', () => {
    render(InstallFirst, { props: { store: fakeStore(), copy: vi.fn() } });
    expect(screen.getByRole('heading').textContent).toMatch(/dev box/);
    expect(screen.getByTestId('install-first').textContent).toMatch(/not used yet/i);
  });

  it('copies the pairing link and confirms it', async () => {
    const copy = vi.fn(async () => undefined);
    render(InstallFirst, { props: { store: fakeStore(), copy } });
    await fireEvent.click(screen.getByRole('button', { name: 'Copy pairing link' }));
    await tick();
    expect(copy).toHaveBeenCalledWith(LINK);
    expect(screen.getByRole('button', { name: /copied/i })).toBeTruthy();
  });

  it('shows the link to copy by hand when the clipboard refuses', async () => {
    const copy = vi.fn(async () => {
      throw new Error('denied');
    });
    render(InstallFirst, { props: { store: fakeStore(), copy } });
    await fireEvent.click(screen.getByRole('button', { name: 'Copy pairing link' }));
    await tick();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(LINK);
  });

  it('pairs in this browser only on request', async () => {
    const store = fakeStore();
    render(InstallFirst, { props: { store, copy: vi.fn() } });
    expect(store.pairInBrowser).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: /pair in this browser instead/i }));
    expect(store.pairInBrowser).toHaveBeenCalledTimes(1);
  });
});
