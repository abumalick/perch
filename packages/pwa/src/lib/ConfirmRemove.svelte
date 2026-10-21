<script lang="ts">
  let { name, onConfirm, onCancel }: { name: string; onConfirm: () => void; onCancel: () => void } = $props();

  let cancel = $state<HTMLButtonElement>();
  $effect(() => cancel?.focus());
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onCancel(); }} />

<button type="button" class="scrim" aria-label="Dismiss" tabindex="-1" onclick={onCancel}></button>
<div class="panel" role="dialog" aria-modal="true" aria-labelledby="confirm-remove-title">
  <h2 id="confirm-remove-title">Remove {name}?</h2>
  <p>This phone forgets <b>{name}</b> and stops connecting to it.</p>
  <p>To get it back, run <code>perch pair</code> on the machine and pair this phone again.</p>
  <div class="buttons">
    <button type="button" class="cancel" bind:this={cancel} onclick={onCancel}>Cancel</button>
    <button type="button" class="remove" aria-label={`Remove ${name}`} onclick={onConfirm}>Remove</button>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    border: 0;
    padding: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 40;
  }
  .panel {
    position: fixed;
    left: 1rem;
    right: 1rem;
    top: 50%;
    transform: translateY(-50%);
    max-width: 24rem;
    margin: 0 auto;
    z-index: 41;
    padding: 1.25rem 1.25rem 1rem;
    border-radius: 0.9rem;
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 1rem 2.5rem rgba(0, 0, 0, 0.5);
  }
  h2 { margin: 0 0 0.6rem; font-size: 1.05rem; }
  p { margin: 0 0 0.5rem; font-size: 0.9rem; line-height: 1.45; color: var(--text-dim); }
  b { color: var(--text); }
  .buttons { display: flex; gap: 0.6rem; margin-top: 1rem; }
  .buttons button {
    flex: 1;
    min-height: 44px;
    border-radius: var(--radius);
    font-size: 0.95rem;
    font-weight: 600;
    touch-action: manipulation;
  }
  .cancel { border: 1px solid var(--border); background: var(--surface-press); color: var(--text); }
  .remove { border: 0; background: var(--danger); color: #fff; }
  .remove:active { filter: brightness(0.9); }
</style>
