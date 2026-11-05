<script lang="ts">
  import type { PerchStore } from '../store.svelte';
  import { msg } from '../i18n.svelte';

  let {
    store,
    copy = (text: string) => navigator.clipboard.writeText(text),
  }: { store: Pick<PerchStore, 'installFirst' | 'pairInBrowser'>; copy?: (text: string) => Promise<void> } = $props();

  let copied = $state<'no' | 'yes' | 'failed'>('no');

  async function copyLink(): Promise<void> {
    try {
      await copy(store.installFirst!.link);
      copied = 'yes';
    } catch {
      copied = 'failed';
    }
  }
</script>

{#if store.installFirst}
  <section class="install" data-testid="install-first">
    <h1>{msg().app.installFirst.title(store.installFirst.name)}</h1>
    <p class="lead">{msg().app.installFirst.lead}</p>
    <ol>
      <li>
        <button type="button" class="cta" onclick={copyLink}>
          {copied === 'yes' ? msg().app.installFirst.copied : msg().app.installFirst.copyLink}
        </button>
        {#if copied === 'failed'}
          <label class="manual">
            {msg().app.installFirst.copyByHand}
            <textarea readonly rows="3" onfocus={(e) => e.currentTarget.select()}>{store.installFirst.link}</textarea>
          </label>
        {/if}
      </li>
      <li>{msg().app.installFirst.openInSafari}</li>
      <li>{msg().app.installFirst.inSafariTap}<b>{msg().app.installFirst.share}</b> → <b>{msg().app.installFirst.addToHomeScreen}</b>{msg().app.installFirst.alreadyOnHomeScreen}</li>
      <li>{msg().app.installFirst.openTarfa}<b>{msg().app.installFirst.addMachine}</b>{msg().app.installFirst.then}<b>{msg().app.installFirst.pastePairingLink}</b>.</li>
    </ol>
    <p class="note">{msg().app.installFirst.notUsedYet}<code>perch pair</code>.</p>
    <button type="button" class="link" onclick={() => store.pairInBrowser()}>{msg().app.installFirst.pairInBrowser}</button>
  </section>
{/if}

<style>
  .install { max-width: 32rem; margin: 0 auto; padding: 1.5rem 1rem calc(1.5rem + env(safe-area-inset-bottom)); }
  h1 { margin: 0; font-size: 1.25rem; line-height: 1.3; }
  .lead { margin: 0.5rem 0 1.25rem; color: var(--text-dim); }
  ol { margin: 0; padding-left: 1.4rem; display: grid; gap: 0.9rem; }
  li { line-height: 1.45; }
  .cta {
    min-height: 44px;
    padding: 0 1.1rem;
    border: 0;
    border-radius: var(--radius);
    background: var(--accent);
    color: #fff;
    font-size: 0.95rem;
    font-weight: 600;
    touch-action: manipulation;
  }
  .cta:active { background: var(--accent-press); }
  .manual { display: block; margin-top: 0.5rem; font-size: 0.85rem; color: var(--text-dim); }
  textarea {
    display: block;
    width: 100%;
    box-sizing: border-box;
    margin-top: 0.25rem;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font-size: 16px;
    word-break: break-all;
  }
  .note { margin: 1.25rem 0 0; font-size: 0.85rem; color: var(--text-dim); }
  .link {
    margin-top: 1.5rem;
    min-height: 44px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-dim);
    font-size: 0.9rem;
    text-decoration: underline;
    touch-action: manipulation;
  }
</style>
