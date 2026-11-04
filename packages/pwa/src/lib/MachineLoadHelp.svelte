<script lang="ts">
  import {
    formatBytes,
    HEADROOM_WARN_BYTES,
    HEADROOM_ALERT_BYTES,
    type LoadDescription,
  } from '../core/machine-load';
  import { msg } from '../i18n.svelte';

  let { load, onClose }: { load: LoadDescription; onClose: () => void } = $props();

  const warn = formatBytes(HEADROOM_WARN_BYTES);
  const alert = formatBytes(HEADROOM_ALERT_BYTES);
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<button type="button" class="scrim" aria-label={msg().load.dismiss} onclick={onClose}></button>
<div class="panel" role="dialog" aria-modal="true" aria-label={msg().load.help} data-testid="machine-load-help">
  <h2>{msg().load.help}</h2>

  <p class="row">
    <b>{msg().load.slowTitle(load.slowLabel)}</b>{msg().load.slowBody(warn, alert)}
  </p>

  {#if load.killLabel}
    <p class="row" data-testid="help-row-kill">
      <b>{msg().load.killTitle(load.killLabel)}</b>{msg().load.killBody}
    </p>
  {/if}

  <p class="row">
    {msg().load.cache}
  </p>

  {#if load.killsSinceConnect > 0}
    <p class="row kills" data-testid="help-row-kills">
      <b>{msg().load.killsTitle(load.killsSinceConnect)}</b>{msg().load.killsBody}
    </p>
  {/if}

  <button type="button" class="done" onclick={onClose}>{msg().load.done}</button>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    border: 0;
    padding: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 40;
  }
  .panel {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: min(32rem, calc(100vw - 2rem));
    max-height: min(80dvh, 40rem);
    overflow-y: auto;
    z-index: 41;
    padding: 1rem 1.15rem 1.15rem;
    border-radius: 0.75rem;
    background: var(--surface, #1b1b1b);
    color: var(--text);
    box-shadow: 0 1rem 2.5rem rgba(0, 0, 0, 0.45);
  }
  h2 {
    margin: 0 0 0.75rem;
    font-size: 1rem;
  }
  .row {
    margin: 0 0 0.7rem;
    font-size: 0.85rem;
    line-height: 1.45;
    color: var(--text-dim);
  }
  .row b {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .kills b {
    color: var(--danger);
  }
  .done {
    width: 100%;
    margin-top: 0.35rem;
    padding: 0.6rem;
    border: 0;
    border-radius: 0.5rem;
    background: var(--accent, #3a3a3a);
    color: var(--text);
    font-size: 0.9rem;
  }
</style>
