<script lang="ts">
  import type { TarfaStore } from '../store.svelte';
  import { parseAgentKey } from '../core/agent-key';
  import { parseAddressLines } from '../core/machine-addresses';
  import { msg } from '../i18n.svelte';

  let { store }: { store: TarfaStore } = $props();

  let name = $state('');
  let addresses = $state('');
  let token = $state('');
  let defaultPath = $state('');
  let agentKey = $state('');
  let keyError = $state('');
  let addressError = $state('');

  function slug(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, '-');
  }

  function add(event: SubmitEvent): void {
    event.preventDefault();
    if (!name || !token) return;
    const parsed = parseAddressLines(addresses);
    addressError = parsed ? '' : msg().settings.addressesInvalid;
    keyError = parseAgentKey(agentKey) ? '' : msg().settings.agentKeyRequired;
    if (!parsed || keyError) return;
    store.addMachine({
      id: slug(name),
      name,
      addresses: parsed,
      token,
      defaultPath: defaultPath || undefined,
      agentKey: agentKey.trim(),
    });
    store.goSettings();
  }
</script>

<section>
  <header>
    <button type="button" class="icon" aria-label={msg().settings.back} onclick={() => store.goSettings()}>‹</button>
    <h2>{msg().settings.addMachine}</h2>
  </header>

  <form onsubmit={add}>
    <label>{msg().settings.name} <input bind:value={name} /></label>
    <label>
      {msg().settings.addresses}
      <textarea bind:value={addresses} rows="3" placeholder="wss://machine.example.ts.net:10000/" autocapitalize="off" autocomplete="off" spellcheck="false"></textarea>
    </label>
    <p class="hint">{msg().settings.addressesHint}</p>
    {#if addressError}<p class="error" role="alert">{addressError}</p>{/if}
    <label>{msg().settings.token} <input bind:value={token} type="password" /></label>
    <label>{msg().settings.defaultPath} <input bind:value={defaultPath} placeholder="/home/u/workspace" /></label>
    <label>
      {msg().settings.agentKey}
      <input bind:value={agentKey} placeholder={msg().settings.agentKeyPlaceholder} autocapitalize="off" autocomplete="off" spellcheck="false" />
    </label>
    {#if keyError}<p class="error" role="alert">{keyError}</p>{/if}
    <button type="submit" class="add" aria-label={msg().settings.addMachine}>＋ {msg().settings.addMachine}</button>
  </form>
</section>

<style>
  header { display: flex; align-items: center; gap: 0.5rem; }
  header h2 { margin: 0; font-size: 1rem; font-weight: 600; }
  label { display: block; margin: 0.5rem 0; }
  input,
  textarea { width: 100%; min-height: 44px; box-sizing: border-box; }
  textarea { font: inherit; resize: vertical; }
  .hint { margin: 0.25rem 0; font-size: 0.8rem; color: var(--text-dim); }
  .error { color: var(--danger, #c0392b); font-size: 0.85rem; margin: 0.25rem 0; }
  button.icon {
    flex: 0 0 auto;
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font-size: 22px;
    line-height: 1;
    touch-action: manipulation;
  }
  button.icon:active { background: var(--surface-press); }
  button.add {
    display: block;
    width: 100%;
    margin-top: 0.75rem;
    min-height: 44px;
    padding: 0 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font-size: 0.9rem;
    touch-action: manipulation;
  }
  button.add:active { background: var(--surface-press); }
</style>
