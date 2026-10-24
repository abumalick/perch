import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import DictationPresets from './DictationPresets.svelte';
import { DEFAULT_CLEANUP_PROMPT, DEFAULT_PRESETS, type DictationPreset } from '../core/dictation-presets';

function fakeStore(presets: DictationPreset[] = [...DEFAULT_PRESETS], extra: { currentPreset?: DictationPreset; addingPreset?: boolean } = {}) {
  return {
    dictationPresets: presets,
    currentPreset: presets[0],
    addingPreset: false,
    ...extra,
    saveDictationPresets: vi.fn(),
    resetDictationPresets: vi.fn(),
  };
}
const saved = (store: ReturnType<typeof fakeStore>) => store.saveDictationPresets.mock.calls.at(-1)![0] as DictationPreset[];

describe('DictationPresets', () => {
  it('lists each preset with its badge', () => {
    render(DictationPresets, { props: { store: fakeStore() as never } });
    expect(screen.getByRole('button', { name: /Edit Scribe/ })).toHaveTextContent('EL');
    expect(screen.getByRole('button', { name: /Edit Clean up/ })).toBeInTheDocument();
  });

  it('highlights the preset in use', () => {
    render(DictationPresets, { props: { store: fakeStore(undefined, { currentPreset: DEFAULT_PRESETS[2] }) as never } });
    expect(screen.getByRole('button', { name: /Edit Fast/ }).closest('li')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /Edit Scribe/ }).closest('li')).not.toHaveAttribute('aria-current');
    expect(screen.getByText('In use')).toBeInTheDocument();
  });

  it('opens a new preset when the mic menu asked for one, once', () => {
    const store = fakeStore(undefined, { addingPreset: true });
    render(DictationPresets, { props: { store: store as never } });
    expect(screen.getByLabelText('Prompt')).toHaveValue(DEFAULT_CLEANUP_PROMPT);
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(store.addingPreset).toBe(false);
  });

  it('edits in a modal that Cancel and Escape close without saving', async () => {
    const store = fakeStore();
    render(DictationPresets, { props: { store: store as never } });
    await fireEvent.click(screen.getByRole('button', { name: /Edit Clean up/ }));
    expect(screen.getByRole('dialog', { name: 'Edit preset' })).toHaveAttribute('aria-modal', 'true');
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Add preset' }));
    expect(screen.getByRole('dialog', { name: 'New preset' })).toBeInTheDocument();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(store.saveDictationPresets).not.toHaveBeenCalled();
  });

  it('edits a preset and saves the whole list', async () => {
    const store = fakeStore();
    render(DictationPresets, { props: { store: store as never } });
    await fireEvent.click(screen.getByRole('button', { name: /Edit Clean up/ }));
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Tidy' } });
    await fireEvent.input(screen.getByLabelText('Prompt'), { target: { value: 'Tidy it.' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save preset' }));
    expect(saved(store)[1]).toMatchObject({ id: 'clean', name: 'Tidy', prompt: 'Tidy it.' });
    expect(saved(store)).toHaveLength(3);
  });

  it('shows OpenRouter fields only for an OpenRouter preset', async () => {
    render(DictationPresets, { props: { store: fakeStore() as never } });
    await fireEvent.click(screen.getByRole('button', { name: /Edit Scribe/ }));
    expect(screen.queryByLabelText('Model')).toBeNull();
    await fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openrouter' } });
    expect(screen.getByLabelText('Model')).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt').tagName).toBe('TEXTAREA');
  });

  it('will not save an invalid preset, and says why', async () => {
    const store = fakeStore();
    render(DictationPresets, { props: { store: store as never } });
    await fireEvent.click(screen.getByRole('button', { name: /Edit Clean up/ }));
    await fireEvent.input(screen.getByLabelText('Badge'), { target: { value: 'TOOLONG' } });
    expect(screen.getByRole('button', { name: 'Save preset' })).toBeDisabled();
    expect(screen.getByText(/badge must be 1 to 3/i)).toBeInTheDocument();
  });

  it('adds a preset prefilled with the cleanup prompt', async () => {
    const store = fakeStore();
    render(DictationPresets, { props: { store: store as never } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add preset' }));
    expect(screen.getByLabelText('Model')).toHaveValue('google/gemini-3.8-flash');
    expect(screen.getByLabelText('Prompt')).toHaveValue(DEFAULT_CLEANUP_PROMPT);
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Translate' } });
    await fireEvent.input(screen.getByLabelText('Badge'), { target: { value: 'TR' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save preset' }));
    const list = saved(store);
    expect(list).toHaveLength(4);
    expect(list[3]).toMatchObject({ name: 'Translate', badge: 'TR', provider: 'openrouter' });
    expect(new Set(list.map((p) => p.id)).size).toBe(4);
  });

  it('deletes and reorders', async () => {
    const store = fakeStore();
    render(DictationPresets, { props: { store: store as never } });
    await fireEvent.click(screen.getByRole('button', { name: 'Move Fast up' }));
    expect(saved(store).map((p) => p.id)).toEqual(['scribe', 'fast', 'clean']);
    await fireEvent.click(screen.getByRole('button', { name: 'Delete Scribe' }));
    expect(saved(store).map((p) => p.id)).toEqual(['clean', 'fast']);
  });

  it('never deletes the last preset', () => {
    render(DictationPresets, { props: { store: fakeStore([DEFAULT_PRESETS[0]!]) as never } });
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
  });

  it('resets to the defaults after a confirmation', async () => {
    const store = fakeStore();
    render(DictationPresets, { props: { store: store as never } });
    await fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(store.resetDictationPresets).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm reset' }));
    expect(store.resetDictationPresets).toHaveBeenCalled();
  });
});
