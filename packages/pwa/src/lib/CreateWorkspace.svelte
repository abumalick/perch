<script lang="ts">
  import type { PerchStore } from '../store.svelte';
  import { resolveProjectPath, displayProjectPath, relativeProjectPath } from '../core/resolve-path';
  import FolderPicker from './FolderPicker.svelte';
  import { buildLauncherOptions, type LauncherOption } from '../core/launchers';

  let { store }: { store: PerchStore } = $props();

  // Only enabled machines the agent currently reports online are selectable — an
  // offline/disabled machine can't create a workspace anyway. Alphabetical by name.
  let connectedMachines = $derived(
    store.machines
      .filter((m) => m.enabled !== false && store.statuses[m.id] === 'online')
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  function initialMachine(list: { id: string }[]): string {
    const last = store.lastMachineId;
    if (last && list.some((m) => m.id === last)) return last;
    return list[0]?.id ?? '';
  }

  const firstModelOf = (options: LauncherOption[], id: string): string => options.find((o) => o.id === id)?.models[0]?.value ?? '';

  // Deliberately a one-time snapshot at mount, not a live reference: the $effect below
  // keeps machineId valid if connectedMachines changes afterward.
  let machineId = $state(initialMachine(connectedMachines));
  let path = $state('');
  // The radios come from the selected machine: what it has installed plus the custom commands
  // launched there before. The form opens on 'claude' (the first option when it is installed);
  // the effect below moves the choice if the option is not on this machine. Switching command
  // resets the model to that command's first option. Last-used command is intentionally not restored.
  let launchers = $derived(buildLauncherOptions(store.machineLaunchers[machineId]));
  let commandId = $state('claude');
  let model = $state(firstModelOf(buildLauncherOptions(undefined), 'claude'));
  let customCommand = $state('');
  let selected = $derived(launchers.find((o) => o.id === commandId));
  let models = $derived(selected?.models ?? []);
  let command = $derived.by(() => {
    if (commandId === 'custom') return customCommand.trim();
    if (!selected) return '';
    return selected.models.length > 0 ? `${selected.base} --model '${model}'` : selected.base;
  });

  function selectCommand(id: string): void {
    commandId = id;
    if (id !== 'custom') model = firstModelOf(launchers, id);
  }

  // A reply that arrives after the form opened, or a switch of machine, can remove the chosen
  // option (Codex not installed there, a forgotten command): fall back to the first one.
  $effect(() => {
    if (commandId !== 'custom' && !selected && launchers[0]) selectCommand(launchers[0].id);
  });

  function forget(option: LauncherOption): void {
    store.forgetLauncher(machineId, option.base);
  }
  // Once the user edits the path, stop overriding it with the machine's recent path.
  let pathEdited = $state(false);
  // True while the folder picker has replaced the form. The component stays mounted, so the
  // form's draft (machine, path, command) survives the round-trip.
  let browsing = $state(false);

  let recentPaths = $derived(store.recentPaths[machineId] ?? []);
  let defaultPath = $derived(store.machines.find((m) => m.id === machineId)?.defaultPath ?? '');
  // What actually gets sent: a relative path is joined onto the machine default, an
  // absolute path passes through, an empty path opens the default root.
  let resolved = $derived(resolveProjectPath(defaultPath || undefined, path));
  // The agent's project roots for this machine — the picker's browse points. Browse is only
  // available when the agent reported at least one (an older agent reports none, so the user
  // falls back to typing the path).
  let roots = $derived(store.machineRoots[machineId] ?? []);

  // Preselect the most-recently-used path for the chosen machine; re-runs when the
  // machine changes or recent paths arrive from the agent, until the user types a path.
  $effect(() => {
    if (!pathEdited) path = recentPaths[0] ?? '';
  });

  // Keep the selection valid if the connected set changes while the form is open
  // (e.g. the selected machine drops offline).
  $effect(() => {
    if (!connectedMachines.some((m) => m.id === machineId)) machineId = initialMachine(connectedMachines);
  });

  function create(event: SubmitEvent): void {
    event.preventDefault();
    if (!machineId || !resolved || !command) return;
    store.requestCreate(machineId, resolved, command, commandId === 'custom');
  }

  function openPicker(): void {
    store.openFolderPicker();
    browsing = true;
    // A single root: dive straight in. Several: the picker shows the roots list first.
    const [only] = roots;
    if (roots.length === 1 && only) store.pickerBrowse(machineId, only);
  }

  function pick(picked: string): void {
    path = relativeProjectPath(defaultPath || undefined, picked);
    pathEdited = true;
    store.closeFolderPicker();
    browsing = false;
  }

  function cancelPicker(): void {
    store.closeFolderPicker();
    browsing = false;
  }
</script>

{#if browsing}
  <FolderPicker {store} {roots} {machineId} onpick={pick} oncancel={cancelPicker} />
{:else}
<section>
  <header>
    <button type="button" class="icon" aria-label="Back" onclick={() => store.cancelCreate()}>‹</button>
    <h2>New workspace</h2>
  </header>

  <fieldset class="radios">
    <legend>Machine</legend>
    {#if connectedMachines.length > 0}
      <div class="radio-row">
        {#each connectedMachines as m (m.id)}
          <label class="radio" class:selected={machineId === m.id}>
            <input type="radio" name="machine" value={m.id} checked={machineId === m.id} onchange={() => (machineId = m.id)} />
            {m.name}
          </label>
        {/each}
      </div>
    {:else}
      <p class="empty">No connected machines</p>
    {/if}
  </fieldset>

  {#if recentPaths.length > 0}
    <p class="recent-label">Recent</p>
    <div class="recent">
      {#each recentPaths as recentPath (recentPath)}
        <button type="button" class:selected={path === recentPath} onclick={() => (path = recentPath)}>{displayProjectPath(defaultPath || undefined, recentPath)}</button>
      {/each}
    </div>
  {/if}

  <form onsubmit={create}>
    <label>
      {#if defaultPath}Path (relative to {defaultPath}){:else}Path{/if}
      <div class="path-row">
        <input
          data-testid="path"
          bind:value={path}
          oninput={() => (pathEdited = true)}
          placeholder={defaultPath ? 'project' : '/home/u/workspace/project'}
        />
        <button type="button" class="browse" aria-label="Browse" disabled={roots.length === 0} onclick={openPicker}>Browse…</button>
      </div>
    </label>
    {#if defaultPath}<p class="resolved" data-testid="resolved-preview">→ {resolved}</p>{/if}
    <fieldset class="radios">
      <legend>Command</legend>
      <div class="radio-row">
        {#each launchers as c (c.id)}
          <span class="launcher">
            <label class="radio" class:selected={commandId === c.id}>
              <input type="radio" name="command" value={c.id} checked={commandId === c.id} onchange={() => selectCommand(c.id)} />
              {c.label}
            </label>
            {#if c.removable}
              <button type="button" class="forget" aria-label="Forget {c.label}" onclick={() => forget(c)}>✕</button>
            {/if}
          </span>
        {/each}
        <label class="radio" class:selected={commandId === 'custom'}>
          <input type="radio" name="command" value="custom" checked={commandId === 'custom'} onchange={() => selectCommand('custom')} />
          Custom…
        </label>
      </div>
    </fieldset>
    {#if models.length > 0}
      <fieldset class="radios">
        <legend>Model</legend>
        <div class="radio-row">
          {#each models as m (m.value)}
            <label class="radio" class:selected={model === m.value}>
              <input type="radio" name="model" value={m.value} checked={model === m.value} onchange={() => (model = m.value)} />
              {m.label}
            </label>
          {/each}
        </div>
      </fieldset>
    {/if}
    {#if commandId === 'custom'}
      <label>Custom command
        <input data-testid="custom-command" bind:value={customCommand} placeholder="claude --resume" />
      </label>
    {/if}
    {#if store.createError}<p class="error" role="alert">⚠ {store.createError}</p>{/if}
    <button type="submit" class="create" disabled={connectedMachines.length === 0}>Create</button>
  </form>
</section>
{/if}

<style>
  /* Match the workspace pages' header: back button inline with the title. */
  header { display: flex; align-items: center; gap: 0.5rem; }
  header button.icon {
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
  header button.icon:active { background: var(--surface-press); }
  header h2 { margin: 0; font-size: 1rem; font-weight: 600; }
  label { display: block; margin: 0.5rem 0; }
  input { width: 100%; min-height: 44px; box-sizing: border-box; }
  .path-row { display: flex; gap: 0.4rem; }
  .path-row input { flex: 1 1 auto; min-width: 0; }
  .browse {
    flex: 0 0 auto;
    min-height: 44px;
    padding: 0 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font-size: 0.85rem;
    white-space: nowrap;
    touch-action: manipulation;
  }
  .browse:active { background: var(--surface-press); }
  .browse:disabled { opacity: 0.5; }
  .recent-label { margin: 1rem 0 0.4rem; font-size: 0.8rem; color: var(--text-dim); }
  .recent { display: flex; flex-direction: column; gap: 0.4rem; }
  .recent button {
    display: block;
    width: 100%;
    text-align: left;
    min-height: 44px;
    padding: 0 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font-size: 0.85rem;
    touch-action: manipulation;
  }
  .recent button:active { background: var(--surface-press); }
  /* The chosen recent path is mirrored into the input; mark it so the source is obvious. */
  .recent button.selected { border-color: var(--accent); color: var(--text); }
  .resolved { margin: 0.25rem 0; font-size: 0.8rem; color: var(--text-dim); word-break: break-all; }
  .error { margin: 0.5rem 0; font-size: 0.85rem; color: var(--danger); word-break: break-all; }
  .radios { border: 0; padding: 0; margin: 0.75rem 0 0; }
  .radios legend { padding: 0; margin-bottom: 0.4rem; font-size: 0.8rem; color: var(--text-dim); }
  .empty { margin: 0; font-size: 0.85rem; color: var(--text-dim); }
  .radio-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .radio {
    position: relative;
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    margin: 0;
    padding: 0 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font-size: 0.85rem;
    touch-action: manipulation;
    cursor: pointer;
  }
  /* A remembered command carries a small round badge on its top-right corner. The room it
     overhangs is margin, not overflow: nothing in the row may clip it. */
  .launcher { position: relative; display: inline-flex; margin: 0.4rem 0.4rem 0 0; }
  .forget {
    position: absolute;
    top: -0.4rem;
    right: -0.4rem;
    width: 20px;
    height: 20px;
    padding: 0;
    display: grid;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: 50%;
    background: var(--surface);
    color: var(--text-dim);
    font-size: 0.6rem;
    line-height: 1;
    touch-action: manipulation;
  }
  /* The badge is 20px to look, ~36px to tap. */
  .forget::after { content: ''; position: absolute; inset: -8px; }
  .forget:active { background: var(--surface-press); }
  .radio:active { background: var(--surface-press); }
  .radio.selected { border-color: var(--accent); background: var(--surface-press); }
  /* The native control fills the chip transparently: selection is shown by the label styling
     above, while the real radio stays the (focusable, tappable) hit target for a11y. */
  .radio input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    min-height: 0;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  button.create {
    width: 100%;
    min-height: 44px;
    margin-top: 1rem;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: var(--accent);
    color: var(--bg);
    font-size: 1rem;
    font-weight: 600;
    touch-action: manipulation;
  }
  button.create:active { opacity: 0.85; }
  button.create:disabled { opacity: 0.5; }
</style>
