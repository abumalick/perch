<script lang="ts">
  import { untrack, onMount } from 'svelte';
  import type { PerchStore } from '../store.svelte';
  import type { ConnectionStatus } from '../core/machine-connection';
  import { trackDimensions, type Dimensions } from './viewport';
  import StatusDot from './StatusDot.svelte';
  import { inputLog, type InputLogRecord } from '../core/terminal-input-log';
  import { isRelayMachine } from '../core/settings-store';
  import { parseAgentKey } from '../core/relay-key';
  import PairMachine from './PairMachine.svelte';
  import { isAndroid } from './android-input';

  let { store }: { store: PerchStore } = $props();

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

  let editingId = $state<string | null>(null);
  let editUrl = $state('');
  let editToken = $state('');
  let editDefaultPath = $state('');
  let editAgentKey = $state('');
  let editKeyError = $state('');
  let originalAgentKey = '';

  function startEdit(machine: { id: string; url: string; defaultPath?: string; agentKey?: string }): void {
    editingId = machine.id;
    editKeyError = '';
    editUrl = machine.url;
    editToken = '';
    editDefaultPath = machine.defaultPath ?? '';
    editAgentKey = machine.agentKey ?? '';
    originalAgentKey = editAgentKey;
  }

  function cancelEdit(): void {
    editingId = null;
  }

  function saveEdit(event: SubmitEvent): void {
    event.preventDefault();
    if (!editingId || !editUrl) return;
    const agentKey = editAgentKey.trim();
    // An entry without a valid key could never connect again, so the key cannot be cleared.
    if (!parseAgentKey(agentKey)) {
      editKeyError = 'Enter the agent key printed by `perch relay-key` on the machine.';
      return;
    }
    store.updateMachine(editingId, {
      url: editUrl,
      token: editToken || undefined,
      defaultPath: editDefaultPath || undefined,
      // Sent only when changed.
      agentKey: agentKey === originalAgentKey ? undefined : agentKey,
    });
    editingId = null;
  }

  function status(id: string): ConnectionStatus {
    return store.statuses?.[id] ?? 'offline';
  }

  function enabled(machine: { enabled?: boolean }): boolean {
    return machine.enabled !== false;
  }

  function dotStatus(machine: { id: string; enabled?: boolean }): ConnectionStatus | 'off' {
    return enabled(machine) ? status(machine.id) : 'off';
  }

  function relative(at: number): string {
    const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    return `${Math.round(mins / 60)}h ago`;
  }

  function saveApiKey(event: SubmitEvent): void {
    event.preventDefault();
    store.setElevenLabsApiKey(apiKey.trim());
  }
</script>

<section>
  <header>
    <button type="button" class="icon" aria-label="Done" onclick={() => store.back()}>‹</button>
    <h2>Machines</h2>
  </header>
  <ul>
    {#each store.machines as machine (machine.id)}
      {@const err = store.lastConnectionError?.[machine.id]}
      <li>
        {#if !isRelayMachine(machine)}
          <div class="row">
            <span class="name">
              <StatusDot status="off" />
              {machine.name}
            </span>
            <span class="actions">
              <button type="button" class="delete" onclick={() => store.removeMachine(machine.id)}>Delete</button>
            </span>
          </div>
          <p class="diag" data-testid="legacy-entry">Old direct entry — no longer supported; pair this machine again</p>
        {:else}
          <div class="row">
            <span class="name">
              <StatusDot status={dotStatus(machine)} />
              {machine.name}
            </span>
            <span class="actions">
              <button
                type="button"
                role="switch"
                class="switch"
                aria-checked={enabled(machine)}
                aria-label={`Connect ${machine.name}`}
                onclick={() => store.toggleMachine(machine.id)}
              >
                <span class="knob"></span>
              </button>
              <button type="button" class="icon" aria-label="Edit" onclick={() => startEdit(machine)}>✎</button>
              <button type="button" class="icon" aria-label="Remove" onclick={() => store.removeMachine(machine.id)}>✕</button>
            </span>
          </div>
          {#if enabled(machine)}
            <span class="state">{status(machine.id)}</span>
            {#if status(machine.id) !== 'online' && err}
              <p class="diag" data-testid="diagnostic">
                {err.message}{#if err.code && !err.refused} (code {err.code}){/if} · {relative(err.at)}
              </p>
              {#if store.deviceKeyUnreadable}
                <button type="button" class="reconnect" onclick={() => store.replaceDeviceKey()}>Make a new device key</button>
              {/if}
            {/if}
            {#if status(machine.id) !== 'online'}
              <button
                type="button"
                class="reconnect"
                data-testid="reconnect"
                onclick={() => store.reconnectMachine(machine.id)}
              >
                Reconnect
              </button>
            {/if}
          {:else}
            <span class="state">off</span>
          {/if}
          {#if editingId === machine.id}
            <form class="edit" onsubmit={saveEdit}>
              <label>URL <input data-testid="edit-url" bind:value={editUrl} /></label>
              <label>
                Token
                <input
                  data-testid="edit-token"
                  bind:value={editToken}
                  type="password"
                  placeholder="leave blank to keep current"
                />
              </label>
              <label>
                Default path
                <input data-testid="edit-default-path" bind:value={editDefaultPath} placeholder="/home/u/workspace" />
              </label>
              <label>
                Agent key
                <input
                  data-testid="edit-agent-key"
                  bind:value={editAgentKey}
                  placeholder="from `perch relay-key` on the machine"
                  autocapitalize="off"
                  autocomplete="off"
                  spellcheck="false"
                />
              </label>
              {#if editKeyError}<p class="diag" role="alert">{editKeyError}</p>{/if}
              <div class="row">
                <button type="submit" class="icon" aria-label="Save">✓</button>
                <button type="button" class="icon" aria-label="Cancel" onclick={cancelEdit}>⨉</button>
              </div>
            </form>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>

  <PairMachine {store} />
  <button type="button" class="add-machine" aria-label="Add machine" onclick={() => store.goNewMachine()}>＋ Add machine by hand</button>

  {#if canShareLinks}
    <h2 class="section">Terminal links</h2>
    <label class="check">
      <input type="checkbox" checked={store.shareLinks} onchange={(e) => store.setShareLinks(e.currentTarget.checked)} />
      Open links with the share sheet
    </label>
    <p class="hint">For a link picker such as LinkSheet: an installed web app keeps links in its own browser view.</p>
  {/if}

  <h2 class="section">Dictation</h2>
  <form onsubmit={saveApiKey}>
    <label>ElevenLabs API key <input bind:value={apiKey} type="password" placeholder="sk_…" /></label>
    <p class="hint">Stored on this device only. Used for speech-to-text in the terminal.</p>
    <button type="submit" class="icon" aria-label="Set API key">✓</button>
  </form>

  <h2 class="section">Diagnostics</h2>
  {#if store.deviceKey}
    {@const { storage, fallback } = store.deviceKey}
    {@const where = (k: string, why?: string) =>
      k === 'webcrypto' ? 'in WebCrypto (non-extractable)' : why ? `stored key (${why})` : 'stored key'}
    <p class="hint" data-testid="device-key">
      Device key {store.deviceKey.fingerprint} · X25519 {where(storage.x25519, fallback?.x25519)} · Ed25519 {where(storage.ed25519, fallback?.ed25519)}
    </p>
  {:else if store.deviceKeyError}
    <p class="hint" data-testid="device-key">Device key unavailable: {store.deviceKeyError}</p>
    {#if store.deviceKeyUnreadable}
      <button type="button" class="reconnect" onclick={() => store.replaceDeviceKey()}>Make a new device key</button>
    {/if}
  {/if}
  <p class="hint" data-testid="viewport">
    Viewport: {dims.width} × {dims.height} · DPR {Math.round(dims.dpr * 100) / 100}
  </p>

  <div class="diag-input" data-testid="input-log">
    <div class="row">
      <p class="hint">Terminal input log ({inputRecords.length})</p>
      <div class="actions">
        <button type="button" class="reconnect" onclick={refreshInputLog}>Refresh</button>
        <button type="button" class="reconnect" onclick={copyInputLog} disabled={inputRecords.length === 0}>Copy</button>
        <button type="button" class="reconnect" onclick={clearInputLog} disabled={inputRecords.length === 0}>Clear</button>
      </div>
    </div>
    {#if inputRecords.length > 0}
      <pre class="log">{#each inputRecords as r}{r.kind}  {r.detail}  →{r.out}
{/each}</pre>
    {:else}
      <p class="hint">Type in a terminal, then Refresh. Captures Android IME events only.</p>
    {/if}
  </div>
</section>

<style>
  header { display: flex; align-items: center; gap: 0.5rem; }
  .section { margin-top: 1.5rem; }
  .check { display: flex; align-items: center; gap: 0.5rem; }
  .hint { margin: 0.25rem 0 0; font-size: 0.8rem; color: var(--text-dim); }
  li { padding: 0.6rem 0; border-bottom: 1px solid var(--border); }
  .row { display: flex; justify-content: space-between; align-items: center; }
  .actions { display: flex; gap: 0.5rem; }
  .name { display: flex; align-items: center; gap: 0.4rem; font-weight: 600; }
  .state { font-size: 0.75rem; color: var(--text-dim); }
  .diag { margin: 0.25rem 0 0; font-size: 0.8rem; color: var(--danger); word-break: break-word; }
  .diag-input { margin-top: 0.5rem; }
  .diag-input .log {
    margin: 0.4rem 0 0;
    max-height: 40vh;
    overflow: auto;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    font-size: 0.72rem;
    line-height: 1.35;
    white-space: pre;
    word-break: normal;
  }
  .reconnect,
  .delete {
    margin-top: 0.4rem;
    min-height: 36px;
    padding: 0 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font-size: 0.85rem;
    touch-action: manipulation;
  }
  .reconnect:active,
  .delete:active { background: var(--surface-press); }
  .add-machine {
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
  .add-machine:active { background: var(--surface-press); }
  .switch {
    width: 44px;
    height: 26px;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    display: inline-flex;
    align-items: center;
    touch-action: manipulation;
  }
  .switch[aria-checked='true'] { background: var(--ok); justify-content: flex-end; }
  .switch[aria-checked='false'] { justify-content: flex-start; }
  .knob {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--text);
  }
  label { display: block; margin: 0.5rem 0; }
  input { width: 100%; min-height: 44px; box-sizing: border-box; }
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
    touch-action: manipulation;
  }
  button.icon:active { background: var(--surface-press); }
</style>
