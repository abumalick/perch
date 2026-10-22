<script lang="ts">
  // Settings editor for the dictation presets the mic's long-press menu offers. Every change
  // saves the whole list, which from then on replaces the built-in defaults.
  import type { PerchStore } from '../store.svelte';
  import {
    DEFAULT_CLEANUP_PROMPT,
    presetError,
    type DictationPreset,
    type DictationProvider,
  } from '../core/dictation-presets';

  let { store }: { store: Pick<PerchStore, 'dictationPresets' | 'saveDictationPresets' | 'resetDictationPresets'> } =
    $props();

  type Draft = { id: string; name: string; badge: string; provider: DictationProvider; model: string; prompt: string };

  // index null = a new preset, appended on save.
  let editing = $state<{ index: number | null; draft: Draft; touched: boolean } | null>(null);
  let confirmingReset = $state(false);

  const presets = $derived(store.dictationPresets);
  const draftPreset = $derived(editing ? toPreset(editing.draft) : null);
  const draftError = $derived(draftPreset ? presetError(draftPreset) : null);

  function toDraft(p: DictationPreset): Draft {
    return p.provider === 'openrouter'
      ? { ...p }
      : { ...p, model: 'google/gemini-3.8-flash', prompt: DEFAULT_CLEANUP_PROMPT };
  }

  function toPreset(d: Draft): DictationPreset {
    const base = { id: d.id, name: d.name.trim(), badge: d.badge.trim() };
    return d.provider === 'openrouter'
      ? { ...base, provider: 'openrouter', model: d.model.trim(), prompt: d.prompt }
      : { ...base, provider: 'elevenlabs' };
  }

  function edit(index: number) {
    editing = { index, draft: toDraft(presets[index]!), touched: false };
  }

  function add() {
    editing = {
      index: null,
      draft: { id: crypto.randomUUID(), name: '', badge: '', provider: 'openrouter', model: 'google/gemini-3.8-flash', prompt: DEFAULT_CLEANUP_PROMPT },
      touched: false,
    };
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    if (!editing || !draftPreset || draftError) return;
    const list = [...presets];
    if (editing.index === null) list.push(draftPreset);
    else list[editing.index] = draftPreset;
    store.saveDictationPresets(list);
    editing = null;
  }

  function move(index: number, by: -1 | 1) {
    const list = [...presets];
    [list[index], list[index + by]] = [list[index + by]!, list[index]!];
    store.saveDictationPresets(list);
  }

  function remove(index: number) {
    store.saveDictationPresets(presets.filter((_, i) => i !== index));
  }

  function reset() {
    store.resetDictationPresets();
    confirmingReset = false;
    editing = null;
  }
</script>

<ul class="presets">
  {#each presets as preset, i (preset.id)}
    <li class="preset">
      <button type="button" class="open" aria-label="Edit {preset.name}" onclick={() => edit(i)}>
        <span class="badge">{preset.badge}</span>
        <span class="label">{preset.name}</span>
        <span class="provider">{preset.provider === 'openrouter' ? preset.model : 'ElevenLabs'}</span>
      </button>
      <button type="button" class="icon" aria-label="Move {preset.name} up" disabled={i === 0} onclick={() => move(i, -1)}>↑</button>
      <button type="button" class="icon" aria-label="Move {preset.name} down" disabled={i === presets.length - 1} onclick={() => move(i, 1)}>↓</button>
      {#if presets.length > 1}
        <button type="button" class="icon danger" aria-label="Delete {preset.name}" onclick={() => remove(i)}>✕</button>
      {/if}
    </li>
  {/each}
</ul>

{#if editing}
  <form class="editor" onsubmit={save} oninput={() => editing && (editing.touched = true)}>
    <label for="preset-name">Name</label>
    <input id="preset-name" bind:value={editing.draft.name} placeholder="Clean up" />
    <label for="preset-badge">Badge</label>
    <input id="preset-badge" bind:value={editing.draft.badge} placeholder="CL" />
    <label for="preset-provider">Provider</label>
    <select id="preset-provider" bind:value={editing.draft.provider}>
      <option value="elevenlabs">ElevenLabs (plain transcript)</option>
      <option value="openrouter">OpenRouter (model + prompt)</option>
    </select>
    {#if editing.draft.provider === 'openrouter'}
      <label for="preset-model">Model</label>
      <input id="preset-model" bind:value={editing.draft.model} placeholder="google/gemini-3.8-flash" autocapitalize="off" spellcheck="false" />
      <label for="preset-prompt">Prompt</label>
      <textarea id="preset-prompt" rows="8" bind:value={editing.draft.prompt}></textarea>
    {/if}
    {#if draftError && editing.touched}<p class="hint error" role="alert">{draftError}</p>{/if}
    <div class="actions">
      <button type="submit" class="small" disabled={!!draftError}>Save preset</button>
      <button type="button" class="small" onclick={() => (editing = null)}>Cancel</button>
    </div>
  </form>
{:else}
  <div class="actions">
    <button type="button" class="small" onclick={add}>Add preset</button>
    {#if confirmingReset}
      <button type="button" class="small danger" onclick={reset}>Confirm reset</button>
      <button type="button" class="small" onclick={() => (confirmingReset = false)}>Keep mine</button>
    {:else}
      <button type="button" class="small" onclick={() => (confirmingReset = true)}>Reset to defaults</button>
    {/if}
  </div>
{/if}

<style>
  .presets { list-style: none; margin: 0.6rem 0 0; padding: 0; }
  .preset { display: flex; align-items: center; gap: 0.3rem; }
  .preset + .preset { border-top: 1px solid var(--border); }
  .open {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex: 1;
    min-width: 0;
    min-height: 44px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text);
    text-align: left;
  }
  .badge { min-width: 2rem; font: 600 0.8rem ui-monospace, monospace; text-align: center; }
  .label { font-weight: 600; font-size: 0.95rem; white-space: nowrap; }
  .provider {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8rem;
    color: var(--text-dim);
  }
  .icon {
    width: 36px;
    height: 36px;
    flex: 0 0 auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-press);
    color: var(--text);
  }
  .icon:disabled { opacity: 0.4; }
  .icon.danger { color: var(--danger); background: transparent; }
  .editor { margin-top: 0.6rem; }
  label { display: block; margin-top: 0.6rem; font-size: 0.85rem; color: var(--text-dim); }
  input,
  select,
  textarea {
    display: block;
    width: 100%;
    box-sizing: border-box;
    margin-top: 0.3rem;
  }
  input,
  select { min-height: 44px; }
  /* The app's global field style covers input and select only, and WebKit keeps drawing its
     own light select unless its appearance is reset. 16px keeps iOS from zooming on focus. */
  select { -webkit-appearance: none; appearance: none; }
  textarea {
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font: 16px/1.35 ui-monospace, monospace;
    resize: vertical;
  }
  textarea:focus { outline: none; border-color: var(--accent); }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.6rem; }
  .small {
    min-height: 44px;
    padding: 0 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-press);
    color: var(--text);
    font-size: 0.85rem;
  }
  .small:disabled { opacity: 0.5; }
  .small.danger { border-color: var(--danger); background: transparent; color: var(--danger); }
  .hint { margin: 0.4rem 0 0; font-size: 0.8rem; }
  .hint.error { color: var(--danger); }
</style>
