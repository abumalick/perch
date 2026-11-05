<script lang="ts">
  import type { PerchStore } from '../store.svelte';
  import { msg } from '../i18n.svelte';

  let { store }: { store: PerchStore } = $props();
</script>

{#if store.deviceNotices.length > 0}
  <div class="notices">
    {#each store.deviceNotices as notice (notice)}
      <div class="notice" role="alert">
        <span class="msg">
          🔑 {msg().app.deviceNotice.newDevice(notice.machine, notice.name, notice.id)}
          <small>{msg().app.deviceNotice.notYou(notice.id)}</small>
        </span>
        <button type="button" class="dismiss" aria-label={msg().app.dismiss} onclick={() => store.dismissDeviceNotice(notice)}>✕</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .notices {
    position: fixed;
    left: 0.75rem;
    right: 0.75rem;
    top: calc(0.75rem + env(safe-area-inset-top));
    max-width: 720px;
    margin: 0 auto;
    display: grid;
    gap: 0.5rem;
    z-index: 11;
  }
  .notice {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    border-radius: 8px;
    background: #2e2a16;
    border: 1px solid #d4a72c;
    color: #eee;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  .msg { flex: 1; font-size: 0.9rem; overflow-wrap: anywhere; }
  small { display: block; margin-top: 0.2rem; color: #bbb; }
  .dismiss {
    width: 36px;
    height: 36px;
    flex: none;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: #ddd;
    font-size: 16px;
    touch-action: manipulation;
  }
  .dismiss:active { background: #45401f; }
</style>
