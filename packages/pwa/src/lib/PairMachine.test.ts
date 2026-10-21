import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import PairMachine from './PairMachine.svelte';

function fakeStore(accepts: (text: string) => boolean = () => true) {
  return {
    pairFromLink: vi.fn((text: string) =>
      accepts(text) ? { name: 'dev' } : { error: 'That is not a Perch pairing code. Run `perch pair` on the machine for a fresh one.' },
    ),
  };
}

describe('PairMachine', () => {
  it('pairs from a pasted link', async () => {
    const store = fakeStore();
    render(PairMachine, { props: { store, scan: vi.fn() } });
    await fireEvent.input(screen.getByLabelText(/paste a pairing link/i), { target: { value: 'https://p/#pair?x' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect(store.pairFromLink).toHaveBeenCalledWith('https://p/#pair?x');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when the pasted text is not a pairing link', async () => {
    render(PairMachine, { props: { store: fakeStore(() => false), scan: vi.fn() } });
    await fireEvent.input(screen.getByLabelText(/paste a pairing link/i), { target: { value: 'hello' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect(screen.getByRole('alert').textContent).toMatch(/not a Perch pairing code/);
  });

  it('scans until a code pairs, then stops the camera', async () => {
    const store = fakeStore((text) => text === 'good');
    const stop = vi.fn();
    let emit: (text: string) => void = () => undefined;
    const scan = vi.fn(async (_video: HTMLVideoElement, onText: (text: string) => void) => {
      emit = onText;
      return stop;
    });
    render(PairMachine, { props: { store, scan } });
    await fireEvent.click(screen.getByRole('button', { name: /scan qr code/i }));
    await tick();
    expect(scan).toHaveBeenCalledWith(expect.any(HTMLVideoElement), expect.any(Function));
    emit('a shop receipt');
    await tick();
    expect(stop).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/not a Perch pairing code/);
    emit('good');
    await tick();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /scan qr code/i })).toBeTruthy();
  });

  it('explains a refused camera and points to the link', async () => {
    const scan = vi.fn(async () => {
      throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    });
    render(PairMachine, { props: { store: fakeStore(), scan } });
    await fireEvent.click(screen.getByRole('button', { name: /scan qr code/i }));
    await tick();
    await tick();
    expect(screen.getByRole('alert').textContent).toMatch(/refused.*paste the pairing link/);
  });
  it('pairs from the link on the clipboard, read on the tap', async () => {
    const store = fakeStore();
    const readClipboard = vi.fn(async () => 'https://p/#pair?x');
    render(PairMachine, { props: { store, scan: vi.fn(), readClipboard } });
    await fireEvent.click(screen.getByRole('button', { name: 'Paste pairing link' }));
    await tick();
    expect(store.pairFromLink).toHaveBeenCalledWith('https://p/#pair?x');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('points to the field when the clipboard cannot be read', async () => {
    const readClipboard = vi.fn(async () => {
      throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    });
    render(PairMachine, { props: { store: fakeStore(), scan: vi.fn(), readClipboard } });
    await fireEvent.click(screen.getByRole('button', { name: 'Paste pairing link' }));
    await tick();
    expect(screen.getByRole('alert').textContent).toMatch(/clipboard.*paste it in the field below/i);
  });
});
