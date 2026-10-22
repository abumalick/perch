import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import DictationMenu from './DictationMenu.svelte';
import { DEFAULT_PRESETS } from '../core/dictation-presets';

const props = {
  presets: [...DEFAULT_PRESETS],
  currentId: 'scribe',
  keys: { elevenlabs: true, openrouter: false },
  anchor: { bottom: 50, right: 10 },
  onSelect: vi.fn(),
  onClose: vi.fn(),
};

describe('DictationMenu', () => {
  it('lists every preset with its badge and marks the current one', () => {
    render(DictationMenu, { props });
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('EL'),
      expect.stringContaining('CL'),
      expect.stringContaining('⚡'),
    ]);
    expect(screen.getByRole('option', { name: /Scribe/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('flags a preset whose provider has no key, leaving it selectable', () => {
    render(DictationMenu, { props });
    const clean = screen.getByRole('option', { name: /Clean up/ });
    expect(clean).toBeEnabled();
    expect(clean).toHaveTextContent('needs key');
    expect(screen.getByRole('option', { name: /Scribe/ })).not.toHaveTextContent('needs key');
  });

  it('selects and closes', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(DictationMenu, { props: { ...props, keys: { elevenlabs: true, openrouter: true }, onSelect, onClose } });
    await fireEvent.click(screen.getByRole('option', { name: /Fast/ }));
    expect(onSelect).toHaveBeenCalledWith('fast');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape and on the backdrop', async () => {
    const onClose = vi.fn();
    render(DictationMenu, { props: { ...props, onClose } });
    await fireEvent.keyDown(window, { key: 'Escape' });
    await fireEvent.click(screen.getByRole('button', { name: 'Close dictation presets' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
