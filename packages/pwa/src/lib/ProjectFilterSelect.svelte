<script lang="ts">
  import type { FilterMode, ProjectFolder } from '../core/project-folders';

  let {
    folders,
    selected,
    mode,
    ontoggle,
    onmode,
    onclear,
  }: {
    folders: ProjectFolder[];
    selected: ReadonlySet<string>;
    mode: FilterMode;
    ontoggle: (key: string) => void;
    onmode: (mode: FilterMode) => void;
    onclear: () => void;
  } = $props();

  // Collapsed summary: no selection means the list is unfiltered in either mode; one selection
  // shows its full path (a nested entry's short label alone would be ambiguous); several
  // collapse to a count so the control stays compact. The verb carries the mode, so the summary
  // alone says whether the list is narrowed or trimmed.
  const subject = $derived(selected.size === 1 ? [...selected][0] : `${selected.size} projects`);
  const summary = $derived(
    selected.size === 0 ? 'All projects' : mode === 'only' ? `Only ${subject}` : `Hiding ${subject}`,
  );

  const MODES = [
    { value: 'only', label: 'Show only' },
    { value: 'hide', label: 'Hide' },
  ] as const;

  let open = $state(false);
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') open = false; }} />

<!-- Nothing to filter with a single project folder — unless a selection is still active, which
     must stay visible and clearable. A native <select multiple> renders poorly on iOS, so this
     is a disclosure of checkboxes: compact when closed, scrollable when open. -->
{#if folders.length > 1 || selected.size > 0}
<div class="project-filter">
  <!-- `open` is fully controlled: the click handler cancels the native disclosure toggle
       and drives `open` itself, so it stays the single source of truth for the backdrop
       and menu below (and so an outside-click/Escape close is a plain state write, not a
       fight with the browser's own toggle). -->
  <details open={open}>
    <summary
      aria-label="Filter by project"
      class:clearable={selected.size > 0}
      onclick={(e) => {
        e.preventDefault();
        open = !open;
      }}
    >
      <span class="summary-text">{summary}</span>
      <span class="chev" aria-hidden="true">▾</span>
    </summary>
    {#if open}
      <button
        type="button"
        class="backdrop"
        aria-label="Close project filter"
        onclick={() => (open = false)}
      ></button>
      <div class="menu" role="group" aria-label="Projects">
        <div class="modes" role="radiogroup" aria-label="Filter mode">
          {#each MODES as option (option.value)}
            <button
              type="button"
              class="mode"
              role="radio"
              aria-checked={mode === option.value}
              onclick={() => onmode(option.value)}
            >
              {option.label}
            </button>
          {/each}
        </div>
        {#each folders as folder (folder.key)}
          <label class="option" style="--depth: {folder.depth}">
            <input
              type="checkbox"
              checked={selected.has(folder.key)}
              onchange={() => ontoggle(folder.key)}
            />
            <span class="label">{folder.label}</span>
            <span class="count">{folder.count}</span>
          </label>
        {/each}
      </div>
    {/if}
  </details>
  <!-- Outside <details>, which hides everything but its <summary> while closed, and outside
       <summary>, whose click toggles the menu. Laid over the summary's right edge. -->
  {#if selected.size > 0}
    <button type="button" class="clear" aria-label="Clear project filter" onclick={onclear}>✕</button>
  {/if}
</div>
{/if}

<style>
  .project-filter {
    margin-top: 0.75rem;
    position: relative;
  }
  details { position: relative; }
  summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-height: 40px;
    padding: 0.3rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font-size: 0.85rem;
    font-weight: 600;
    list-style: none;
    cursor: pointer;
    touch-action: manipulation;
  }
  summary.clearable { padding-right: 44px; }
  summary::-webkit-details-marker { display: none; }
  summary:active { background: var(--surface-press); }
  .summary-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chev { flex: 0 0 auto; color: var(--text-dim); font-size: 0.8rem; }
  details[open] .chev { transform: rotate(180deg); }

  /* Spans the summary's height at its right edge, in the room `.clearable` leaves there; above
     the backdrop so it also works with the menu open. The wrapper is as tall as the summary
     alone, since the menu is absolutely positioned. */
  .clear {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    z-index: 6;
    width: 44px;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--text-dim);
    font-size: 0.9rem;
    cursor: pointer;
    touch-action: manipulation;
  }
  .clear:active { color: var(--text); }

  /* Transparent full-screen catcher so a tap outside the menu closes it. */
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 4;
    border: 0;
    background: transparent;
    padding: 0;
  }

  /* The open menu floats over the list so toggling filters doesn't shove the rows down.
     Capped height keeps a long project list scrollable on a short phone screen. */
  .menu {
    position: absolute;
    z-index: 5;
    left: 0;
    right: 0;
    margin-top: 0.3rem;
    max-height: 50vh;
    overflow-y: auto;
    padding: 0.3rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  /* Segmented control: the verb the checkbox list below is read with. */
  .modes {
    display: flex;
    gap: 0.2rem;
    padding: 0.2rem;
    margin-bottom: 0.2rem;
    border-radius: var(--radius);
    background: var(--surface-press);
  }
  .mode {
    flex: 1;
    min-height: 32px;
    border: 0;
    border-radius: calc(var(--radius) - 2px);
    background: transparent;
    color: var(--text-dim);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    touch-action: manipulation;
  }
  .mode[aria-checked='true'] {
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  }

  .option {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-height: 40px;
    padding: 0.3rem 0.5rem 0.3rem calc(0.5rem + var(--depth, 0) * 1.25rem);
    border-radius: var(--radius);
    cursor: pointer;
    touch-action: manipulation;
  }
  .option:active { background: var(--surface-press); }
  .option input { width: 18px; height: 18px; flex: 0 0 auto; accent-color: var(--accent); }
  .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count {
    flex: 0 0 auto;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-dim);
    background: var(--surface-press);
    border: 1px solid var(--border);
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
  }
</style>
