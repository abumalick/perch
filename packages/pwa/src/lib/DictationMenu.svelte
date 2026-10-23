<script lang="ts">
  // The mic's long-press menu: pick the dictation preset the next recording uses. Positioned
  // fixed against the viewport like CommandPicker, since the keyboard bar clips its overflow.
  // A preset whose provider has no key stays selectable, only flagged: dictating with it then
  // says which key to set, and a user with no key at all can still switch back.
  import { needsKey, type DictationPreset, type DictationProvider } from '../core/dictation-presets';

  let {
    presets,
    currentId,
    keys,
    anchor,
    onSelect,
    onClose,
    onAdd,
  }: {
    presets: DictationPreset[];
    currentId: string;
    keys: Record<DictationProvider, boolean>;
    anchor: { bottom: number; right: number };
    onSelect: (id: string) => void;
    onClose: () => void;
    onAdd: () => void;
  } = $props();

  const keepFocus = (e: Event) => e.preventDefault();

  function choose(id: string) {
    onSelect(id);
    onClose();
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<button type="button" class="backdrop" aria-label="Close dictation presets" onpointerdown={keepFocus} onclick={onClose}></button>
<div class="menu" style="bottom: {anchor.bottom}px; right: {anchor.right}px">
  <ul role="listbox" aria-label="Dictation presets">
    {#each presets as preset (preset.id)}
      {@const missing = needsKey(preset, keys)}
      <li>
        <button
          type="button"
          role="option"
          aria-selected={preset.id === currentId}
          onpointerdown={keepFocus}
          onclick={() => choose(preset.id)}
        >
          <span class="badge">{preset.badge}</span>
          <span class="name">{preset.name}</span>
          {#if missing}<span class="hint">needs key</span>{:else if preset.id === currentId}<span class="hint">✓</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
  <button type="button" class="add" onpointerdown={keepFocus} onclick={() => { onClose(); onAdd(); }}>Add preset…</button>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 20;
    border: 0;
    background: transparent;
    padding: 0;
  }
  .menu {
    position: fixed;
    z-index: 21;
    margin: 0;
    padding: 0.25rem;
    min-width: 12rem;
    max-width: calc(100vw - 8px);
    max-height: 50vh;
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  ul { margin: 0; padding: 0; list-style: none; }
  .menu .add { border-top: 1px solid var(--border); border-radius: 0; color: var(--text-dim, var(--text)); }
  .menu button {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.6rem;
    border: 0;
    border-radius: calc(var(--radius) - 2px);
    background: transparent;
    color: var(--text);
    font: 400 0.95rem system-ui, sans-serif;
    text-align: left;
    touch-action: manipulation;
  }
  .menu button:active { background: var(--surface-press); }
  .menu button[aria-selected='true'] { background: var(--surface-press); }
  .badge {
    min-width: 2rem;
    font: 600 0.8rem ui-monospace, monospace;
    text-align: center;
  }
  .name { flex: 1; }
  .hint { font-size: 0.8rem; color: var(--text-dim, var(--text)); }
</style>
