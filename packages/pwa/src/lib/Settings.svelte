<script lang="ts">
  import { untrack, onMount } from 'svelte';
  import type { TarfaStore } from '../store.svelte';
  import type { MachineConfig } from '../core/settings-store';
  import type { ConnectionStatus } from '../core/machine-connection';
  import { trackDimensions, type Dimensions } from './viewport';
  import StatusDot from './StatusDot.svelte';
  import { inputLog, type InputLogRecord } from '../core/terminal-input-log';
  import { addressHost } from '../core/machine-addresses';
  import PairMachine from './PairMachine.svelte';
  import MachineDetail from './MachineDetail.svelte';
  import DictationPresets from './DictationPresets.svelte';
  import { STATUS_LABEL, describeConnectionError } from './machine-status';
  import { isAndroid } from './android-input';
  import { msg } from '../i18n.svelte';
  import { LANGUAGES, type LanguageChoice } from '../core/i18n/language';

  let { store }: { store: TarfaStore } = $props();

  const canShareLinks = isAndroid(navigator.userAgent) && typeof navigator.share === 'function';

  let dims = $state<Dimensions>({ width: 0, height: 0, dpr: 1 });
  onMount(() => trackDimensions((d) => (dims = d)));

  // Terminal input diagnostics: a snapshot of the Android IME event stream, refreshed on
  // demand (the log is written from the terminal view). Empty on iOS, where it never runs.
  let inputRecords = $state<InputLogRecord[]>(inputLog.snapshot());
  function refreshInputLog(): void {
    inputRecords = inputLog.snapshot();
  }
  function clearInputLog(): void {
    inputLog.clear();
    inputRecords = [];
  }
  async function copyInputLog(): Promise<void> {
    const text = inputRecords.map((r) => `${r.kind}\t${r.detail}\t${r.out}`).join('\n');
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // clipboard unavailable — nothing copied, no error surfaced
    }
  }

  // Seed the editable field from the persisted key once; untrack marks this as an
  // intentional initial-value read (not a reactive dependency).
  let apiKey = $state(untrack(() => store.elevenLabsApiKey));
  let apiKeySaved = $state(false);
  let openRouterKey = $state(untrack(() => store.openRouterApiKey));
  let openRouterKeySaved = $state(false);

  let openId = $state<string | null>(null);
  // Closes by itself if the entry goes away underneath (removed from another page context).
  const openMachine = $derived(store.machines.find((m) => m.id === openId) ?? null);


  let addOpen = $state(false);
  const showAdd = $derived(addOpen || store.machines.length === 0);

  function enabled(machine: { enabled?: boolean }): boolean {
    return machine.enabled !== false;
  }

  function statusOf(machine: MachineConfig) {
    const status: ConnectionStatus = store.statuses?.[machine.id] ?? 'offline';
    const shown: ConnectionStatus | 'off' = enabled(machine) ? status : 'off';
    const err = enabled(machine) && status !== 'online' ? store.lastConnectionError?.[machine.id] : undefined;
    return { shown, err };
  }

  function saveApiKey(event: SubmitEvent): void {
    event.preventDefault();
    store.setElevenLabsApiKey(apiKey.trim());
    apiKeySaved = true;
  }

  function saveOpenRouterKey(event: SubmitEvent): void {
    event.preventDefault();
    store.setOpenRouterApiKey(openRouterKey.trim());
    openRouterKeySaved = true;
  }
</script>

{#if openMachine}
  <MachineDetail {store} machine={openMachine} onClose={() => (openId = null)} />
{:else}
  <section>
    <header>
      <button type="button" class="icon" aria-label={msg().settings.back} onclick={() => store.back()}>‹</button>
      <h2>{msg().settings.title}</h2>
    </header>

    {#if store.deviceKeyError}
      <div class="card notice">
        <p data-testid="device-key">{msg().settings.deviceKeyUnavailable(store.deviceKeyError)}</p>
        {#if store.deviceKeyUnreadable}
          <button type="button" class="wide" onclick={() => store.replaceDeviceKey()}>{msg().settings.newDeviceKey}</button>
        {/if}
      </div>
    {/if}

    <p class="group">{msg().settings.machines}</p>
    <ul class="card list">
      {#each store.machines as machine (machine.id)}
        {@const { shown, err } = statusOf(machine)}
        <li>
            <div class="row">
              <button type="button" class="open" onclick={() => (openId = machine.id)}>
                <span class="dot" aria-hidden="true"><StatusDot status={shown} /></span>
                <span class="text">
                  <span class="title">
                    <span class="name">{machine.name}</span>
                    <span class="host" data-testid="machine-host">{addressHost(machine.addresses?.[0] ?? '')}{#if (machine.addresses?.length ?? 0) > 1}{' '}+{machine.addresses.length - 1}{/if}</span>
                  </span>
                  {#if err}
                    <span class="sub diag" data-testid="diagnostic">{describeConnectionError(err)}</span>
                  {:else}
                    <span class="sub">{STATUS_LABEL[shown]}</span>
                  {/if}
                </span>
                <span class="chevron" aria-hidden="true">›</span>
              </button>
              <button
                type="button"
                role="switch"
                class="switch"
                aria-checked={enabled(machine)}
                aria-label={msg().settings.connectMachine(machine.name)}
                onclick={() => store.toggleMachine(machine.id)}
              >
                <span class="knob"></span>
              </button>
            </div>
        </li>
      {/each}
      <li>
        <button
          type="button"
          class="row add"
          aria-expanded={showAdd}
          onclick={() => (addOpen = !showAdd)}
        >
          <span class="plus" aria-hidden="true">＋</span>
          <span>{msg().settings.addMachine}</span>
        </button>
      </li>
    </ul>

    {#if showAdd}
      <div class="card add-panel">
        <PairMachine {store} />
        <button type="button" class="link" onclick={() => store.goNewMachine()}>{msg().settings.enterByHand}</button>
      </div>
    {/if}

    <p class="group">{msg().settings.dictation}</p>
    <form class="card" onsubmit={saveApiKey}>
      <label for="elevenlabs-key">{msg().settings.elevenLabsKey}</label>
      <div class="inline">
        <input id="elevenlabs-key" bind:value={apiKey} oninput={() => (apiKeySaved = false)} type="password" placeholder="sk_…" />
        <button type="submit" class="small">{msg().settings.saveKey}</button>
      </div>
      {#if apiKeySaved}
        <p class="hint ok" role="status">{msg().settings.saved}</p>
      {:else}
        <p class="hint">{msg().settings.elevenLabsHint}</p>
      {/if}
    </form>
    <form class="card" onsubmit={saveOpenRouterKey}>
      <label for="openrouter-key">{msg().settings.openRouterKey}</label>
      <div class="inline">
        <input id="openrouter-key" bind:value={openRouterKey} oninput={() => (openRouterKeySaved = false)} type="password" placeholder="sk-or-…" />
        <button type="submit" class="small">{msg().settings.saveKey}</button>
      </div>
      {#if openRouterKeySaved}
        <p class="hint ok" role="status">{msg().settings.saved}</p>
      {:else}
        <p class="hint">{msg().settings.openRouterHint}</p>
      {/if}
    </form>
    <div class="card">
      <span class="name">{msg().settings.presets}</span>
      <p class="hint">{msg().settings.presetsHint}</p>
      <DictationPresets {store} />
    </div>

    {#if canShareLinks}
      <p class="group">{msg().settings.terminalLinks}</p>
      <div class="card">
        <div class="row">
          <span class="text"><span class="name">{msg().settings.shareLinks}</span></span>
          <button
            type="button"
            role="switch"
            class="switch"
            aria-checked={store.shareLinks}
            aria-label={msg().settings.shareLinks}
            onclick={() => store.setShareLinks(!store.shareLinks)}
          >
            <span class="knob"></span>
          </button>
        </div>
        <p class="hint">{msg().settings.shareLinksHint}</p>
      </div>
    {/if}

    <p class="group">{msg().settings.language}</p>
    <div class="card">
      <label for="language">{msg().settings.language}</label>
      <select id="language" value={store.languageChoice} onchange={(e) => store.setLanguageChoice(e.currentTarget.value as LanguageChoice)}>
        <option value="auto">{msg().settings.languageAuto}</option>
        {#each LANGUAGES as code (code)}
          <option value={code}>{msg().settings.languageNames[code]}</option>
        {/each}
      </select>
    </div>

    <details class="card diagnostics">
      <summary>{msg().settings.diagnostics}</summary>
      {#if store.deviceKey}
        {@const { storage, fallback } = store.deviceKey}
        {@const where = (k: string, why?: string) =>
          k === 'webcrypto' ? msg().settings.keyInWebCrypto : why ? msg().settings.keyStoredBecause(why) : msg().settings.keyStored}
        <p class="hint" data-testid="device-key">
          {msg().settings.deviceKeyLine(store.deviceKey.fingerprint, where(storage.x25519, fallback?.x25519), where(storage.ed25519, fallback?.ed25519))}
        </p>
      {/if}
      <p class="hint" data-testid="viewport">
        {msg().settings.viewport} {dims.width} × {dims.height} · DPR {Math.round(dims.dpr * 100) / 100}
      </p>

      <div class="diag-input" data-testid="input-log">
        <div class="log-head">
          <p class="hint">{msg().settings.inputLog(inputRecords.length)}</p>
          <div class="actions">
            <button type="button" class="small" onclick={refreshInputLog}>{msg().settings.refresh}</button>
            <button type="button" class="small" onclick={copyInputLog} disabled={inputRecords.length === 0}>{msg().settings.copy}</button>
            <button type="button" class="small" onclick={clearInputLog} disabled={inputRecords.length === 0}>{msg().settings.clear}</button>
          </div>
        </div>
        {#if inputRecords.length > 0}
          <pre class="log">{#each inputRecords as r}{r.kind}  {r.detail}  →{r.out}
{/each}</pre>
        {:else}
          <p class="hint">{msg().settings.inputLogEmpty}</p>
        {/if}
      </div>
    </details>
  </section>
{/if}

<style>
  header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; }
  h2 { margin: 0; font-size: 1.15rem; }
  .group {
    margin: 1.4rem 0 0.4rem 0.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .card {
    margin: 0;
    padding: 0.75rem 0.9rem;
    border-radius: 0.75rem;
    background: var(--surface);
  }
  .notice { margin-top: 0.75rem; border: 1px solid var(--danger); }
  .notice p { margin: 0; font-size: 0.85rem; color: var(--danger); word-break: break-word; }
  .list { list-style: none; padding: 0; overflow: hidden; }
  .list li + li { border-top: 1px solid var(--border); }
  .row { display: flex; align-items: center; gap: 0.6rem; }
  .list .row { min-height: 56px; padding: 0 0.9rem; }
  .list .row:has(.open) { padding-left: 0; }
  .text { display: flex; flex-direction: column; flex: 1; min-width: 0; text-align: left; }
  .name { font-weight: 600; font-size: 0.95rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title { display: flex; align-items: baseline; gap: 0.4rem; min-width: 0; }
  .title .name { flex-shrink: 0; max-width: 60%; }
  .host { font-size: 0.8rem; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .sub { font-size: 0.8rem; color: var(--text-dim); word-break: break-word; }
  .sub.diag { color: var(--danger); }
  button { touch-action: manipulation; }
  .open {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex: 1;
    min-width: 0;
    min-height: 56px;
    padding: 0.5rem 0 0.5rem 0.9rem;
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
  }
  .open:active,
  .add:active { background: var(--surface-press); }
  .dot { display: inline-flex; }
  .chevron { color: var(--text-dim); font-size: 1.3rem; padding-right: 0.25rem; }
  .add {
    width: 100%;
    border: 0;
    background: transparent;
    color: var(--accent);
    font: inherit;
    font-weight: 600;
  }
  .plus { width: 0.6rem; display: grid; place-items: center; }
  .add-panel { margin-top: 0.6rem; }
  .add-panel :global(.pair) { margin-top: 0; }
  .link {
    display: block;
    margin: 0.75rem auto 0;
    min-height: 44px;
    border: 0;
    background: transparent;
    color: var(--accent);
    font-size: 0.9rem;
  }
  label { display: block; font-size: 0.85rem; color: var(--text-dim); }
  #language { display: block; width: 100%; min-height: 44px; margin-top: 0.4rem; box-sizing: border-box; }
  .inline { display: flex; gap: 0.5rem; margin-top: 0.3rem; }
  .inline input { flex: 1; min-width: 0; min-height: 44px; box-sizing: border-box; }
  .hint { margin: 0.4rem 0 0; font-size: 0.8rem; color: var(--text-dim); }
  .hint.ok { color: var(--ok); }
  .small,
  .wide {
    min-height: 44px;
    padding: 0 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-press);
    color: var(--text);
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .small:disabled { opacity: 0.5; }
  .wide { display: block; width: 100%; margin-top: 0.6rem; }
  .switch {
    flex: 0 0 auto;
    width: 50px;
    height: 30px;
    padding: 2px;
    border: 0;
    border-radius: 999px;
    background: var(--border);
    display: inline-flex;
    align-items: center;
    transition: background 0.15s;
  }
  .switch[aria-checked='true'] { background: var(--ok); justify-content: flex-end; }
  .switch[aria-checked='false'] { justify-content: flex-start; }
  .knob { width: 26px; height: 26px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4); }
  .diagnostics { margin-top: 1.4rem; }
  summary { min-height: 32px; display: flex; align-items: center; cursor: pointer; color: var(--text-dim); font-size: 0.9rem; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: '›'; display: inline-block; width: 1rem; transition: transform 0.15s; }
  details[open] summary::before { transform: rotate(90deg); }
  .diag-input { margin-top: 0.5rem; }
  .log-head { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .actions { display: flex; gap: 0.4rem; }
  .log {
    margin: 0.4rem 0 0;
    max-height: 40vh;
    overflow: auto;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    font-size: 0.72rem;
    line-height: 1.35;
    white-space: pre;
  }
  button.icon {
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
  }
  button.icon:active { background: var(--surface-press); }
</style>
