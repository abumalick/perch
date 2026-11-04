<script lang="ts">
  import { msg } from '../i18n.svelte';

  let { text, onCopy, onDismiss }: { text: string; onCopy: () => void; onDismiss: () => void } = $props();

  const keepFocus = (e: Event) => e.preventDefault();
</script>

<div class="offer" role="region" aria-label={msg().app.copyOffer.label} data-testid="copy-offer">
  <span class="msg">
    <span class="label">{msg().app.copyOffer.label}</span>
    <span class="preview">{text}</span>
  </span>
  <button type="button" class="copy" onpointerdown={keepFocus} onclick={onCopy}>{msg().app.copyOffer.copy}</button>
  <button type="button" class="dismiss" aria-label={msg().app.dismiss} onpointerdown={keepFocus} onclick={onDismiss}>✕</button>
</div>

<style>
  .offer {
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
    display: flex;
    flex-direction: column;
    font-size: 0.9rem;
  }
  .label { font-weight: 600; }
  .preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #bbb;
    font-family: monospace;
    font-size: 0.8rem;
  }
  button {
    min-height: 36px;
    padding: 0 0.75rem;
    border: 0;
    border-radius: 5px;
    font-size: 0.9rem;
    touch-action: manipulation;
  }
  .copy { background: #3b82f6; color: #fff; }
  .dismiss { background: transparent; color: #ddd; border: 1px solid #555; }
</style>
