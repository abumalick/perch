<script lang="ts">
  import type { PerchStore } from '../store.svelte';

  let { store }: { store: PerchStore } = $props();

  // A shared file is attached on this tap only: the share target cannot tell the OS share sheet
  // from a page that hides its referrer, so the user sees what would be sent, and where, first.
  const shared = $derived(store.active ? store.pendingSharedFile : null);
  const online = $derived(store.active ? store.statuses[store.active.machineId] === 'online' : false);

  function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

{#if shared && store.active}
  <div class="confirm" role="region" aria-label="Shared file" data-testid="shared-file-confirm">
    <span class="msg">
      Attach <strong>{shared.name}</strong> ({size(shared.bytes.length)}) to <strong>{store.active.name}</strong>?
    </span>
    <button type="button" class="attach" disabled={!online} onclick={() => store.attachSharedFile()}>Attach</button>
    <button type="button" class="discard" onclick={() => store.discardSharedFile()}>Discard</button>
  </div>
{/if}

<style>
  .confirm {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: #1f2a3a;
    border-bottom: 1px solid #2f3f55;
    color: #eee;
  }
  .msg {
    flex: 1;
    min-width: 0;
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }
  button {
    min-height: 36px;
    padding: 0 0.75rem;
    border: 0;
    border-radius: 5px;
    font-size: 0.9rem;
    touch-action: manipulation;
  }
  .attach { background: #3b82f6; color: #fff; }
  .attach:disabled { opacity: 0.5; }
  .discard { background: transparent; color: #ddd; border: 1px solid #555; }
</style>
