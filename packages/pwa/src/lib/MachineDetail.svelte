<script lang="ts">
  import { untrack } from 'svelte';
  import type { PerchStore } from '../store.svelte';
  import type { MachineConfig } from '../core/settings-store';
  import { parseAgentKey } from '../core/relay-key';
  import StatusDot from './StatusDot.svelte';
  import ConfirmRemove from './ConfirmRemove.svelte';
  import { STATUS_LABEL, describeConnectionError } from './machine-status';

  let {
    store,
    machine,
    onClose,
  }: {
    store: Pick<PerchStore, 'statuses' | 'lastConnectionError' | 'updateMachine' | 'removeMachine' | 'reconnectMachine'>;
    machine: MachineConfig;
    onClose: () => void;
  } = $props();

  // The form edits a copy taken when the page opens; untrack marks these as initial values.
  const initial = untrack(() => machine);
  let url = $state(initial.url);
  let token = $state('');
  let defaultPath = $state(initial.defaultPath ?? '');
  let agentKey = $state(initial.agentKey ?? '');
  let keyError = $state('');
  let advancedOpen = $state(false);
  let confirming = $state(false);

  const enabled = $derived(machine.enabled !== false);
  const status = $derived(store.statuses?.[machine.id] ?? 'offline');
  const shown = $derived(enabled ? status : 'off');
  const err = $derived(enabled && status !== 'online' ? store.lastConnectionError?.[machine.id] : undefined);

  function save(event: SubmitEvent): void {
    event.preventDefault();
    if (!url) return;
    const key = agentKey.trim();
    // An entry without a valid key could never connect again, so the key cannot be cleared.
    if (!parseAgentKey(key)) {
      keyError = 'Enter the agent key printed by `perch relay-key` on the machine.';
      advancedOpen = true;
      return;
    }
    store.updateMachine(machine.id, {
      url,
      token: token || undefined,
      defaultPath: defaultPath || undefined,
      // Sent only when changed.
      agentKey: key === initial.agentKey ? undefined : key,
    });
    onClose();
  }

  function remove(): void {
    confirming = false;
    store.removeMachine(machine.id);
    onClose();
  }
</script>

<section>
  <header>
    <button type="button" class="icon" aria-label="Back" onclick={onClose}>‹</button>
    <h2>{machine.name}</h2>
  </header>

  <div class="card status">
    <div class="status-line">
      <StatusDot status={shown} />
      <span>{STATUS_LABEL[shown]}</span>
    </div>
    {#if err}
      <p class="diag" data-testid="diagnostic">{describeConnectionError(err)}</p>
    {/if}
    {#if enabled && status !== 'online'}
      <button type="button" class="secondary" data-testid="reconnect" onclick={() => store.reconnectMachine(machine.id)}>
        Reconnect
      </button>
    {/if}
  </div>

  <form onsubmit={save}>
    <p class="group">Workspaces</p>
    <div class="card">
      <label>
        Default path
        <input data-testid="edit-default-path" bind:value={defaultPath} placeholder="/home/u/workspace" autocapitalize="off" spellcheck="false" />
      </label>
      <p class="hint">Where the folder picker starts when you create a workspace.</p>
    </div>

    <details class="card advanced" bind:open={advancedOpen}>
      <summary>Advanced connection settings</summary>
      <label>Relay URL <input data-testid="edit-url" bind:value={url} autocapitalize="off" spellcheck="false" /></label>
      <label>
        Token
        <input data-testid="edit-token" bind:value={token} type="password" placeholder="leave blank to keep current" />
      </label>
      <label>
        Agent key
        <input
          data-testid="edit-agent-key"
          bind:value={agentKey}
          placeholder="from `perch relay-key` on the machine"
          autocapitalize="off"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      {#if keyError}<p class="diag" role="alert">{keyError}</p>{/if}
    </details>

    <button type="submit" class="primary">Save</button>
  </form>

  <div class="danger-zone">
    <button type="button" class="danger" onclick={() => (confirming = true)}>Remove machine</button>
    <p class="hint">This phone forgets the machine. Pairing it again needs <code>perch pair</code> on the machine.</p>
  </div>
</section>

{#if confirming}
  <ConfirmRemove name={machine.name} onConfirm={remove} onCancel={() => (confirming = false)} />
{/if}

<style>
  header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
  h2 { margin: 0; font-size: 1.15rem; overflow-wrap: anywhere; }
  .group {
    margin: 1.25rem 0 0.4rem 0.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .card {
    padding: 0.75rem 0.9rem;
    border-radius: 0.75rem;
    background: var(--surface);
  }
  .status-line { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; }
  .advanced { margin-top: 0.75rem; }
  summary { min-height: 28px; display: flex; align-items: center; cursor: pointer; color: var(--text-dim); font-size: 0.9rem; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: '›'; display: inline-block; width: 1rem; transition: transform 0.15s; }
  details[open] summary::before { transform: rotate(90deg); }
  label { display: block; margin: 0.6rem 0 0; font-size: 0.85rem; color: var(--text-dim); }
  .card > label:first-child { margin-top: 0; }
  input { display: block; width: 100%; min-height: 44px; box-sizing: border-box; margin-top: 0.3rem; }
  .hint { margin: 0.4rem 0 0; font-size: 0.8rem; color: var(--text-dim); }
  .diag { margin: 0.4rem 0 0; font-size: 0.8rem; color: var(--danger); word-break: break-word; }
  button { touch-action: manipulation; }
  .primary,
  .secondary,
  .danger {
    display: block;
    width: 100%;
    min-height: 44px;
    padding: 0 0.9rem;
    border-radius: var(--radius);
    font-size: 0.95rem;
  }
  .primary { margin-top: 1rem; border: 0; background: var(--accent); color: #fff; font-weight: 600; }
  .primary:active { background: var(--accent-press); }
  .secondary { margin-top: 0.6rem; border: 1px solid var(--border); background: var(--surface-press); color: var(--text); }
  .danger-zone { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--border); }
  .danger { border: 1px solid var(--danger); background: transparent; color: var(--danger); }
  .danger:active { background: rgba(231, 76, 60, 0.12); }
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
