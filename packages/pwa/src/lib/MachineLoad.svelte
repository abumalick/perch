<script lang="ts">
  import type { MachineStats } from '@perch/contracts';
  import { describeLoad } from '../core/machine-load';
  import MachineLoadHelp from './MachineLoadHelp.svelte';

  let {
    stats,
    name = '',
    killsSinceConnect = 0,
  }: { stats: MachineStats; name?: string; killsSinceConnect?: number } = $props();

  const load = $derived(describeLoad(stats, killsSinceConnect));
  let helpOpen = $state(false);
</script>

<!-- Ambient readout, not an alert: the figures are aria-hidden because they say nothing a
     user acts on by ear. The attribute sits on the figures and NOT on the wrapper — a
     focusable button inside an aria-hidden subtree cannot be reached at all. -->
<div class="load" data-testid="machine-load" data-band={load.band}>
  <span class="figures" data-testid="machine-load-figures" aria-hidden="true">
  {#if name}
    <span class="name" data-testid="machine-load-name">{name}</span>
  {/if}
  <span>CPU <span class="num" data-testid="machine-load-cpu">{load.cpu}</span></span>
  <!-- Reclaimable cache counts as free in both figures, so they move only with memory the
       machine cannot hand back. -->
  <span class="ram" data-testid="machine-load-ram">
    RAM <span class="num head" data-testid="machine-load-headroom">{load.slowLabel}</span> left{' '}
    {#if load.killLabel}<span class="detail" data-testid="machine-load-kill">· {load.killLabel} before kill</span>{/if}
  </span>
  </span>
  <button
    type="button"
    class="help"
    data-testid="machine-load-help-open"
    aria-label="What these numbers mean"
    onclick={() => (helpOpen = true)}>?</button>
</div>

{#if helpOpen}
  <MachineLoadHelp {load} onClose={() => (helpOpen = false)} />
{/if}

<style>
  .figures {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
    overflow: hidden;
  }
  /* No `overflow: hidden` here: the help button is deliberately taller than this line (a
     32px tap target pulled back with negative margins), and clipping the row would shave its
     top and bottom into an ellipse. Truncation belongs to `.figures`, which owns it. */
  .load {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin-top: 0.5rem;
    color: var(--text-dim);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .name {
    color: var(--text);
    font-weight: 600;
  }
  /* Pinned right and never the thing that gets clipped: the detail span truncates first.
     A 32px box is the smallest reliably tappable target on a phone, and the negative margin
     buys it without making this line taller than the rest of the strip. */
  .help {
    flex-shrink: 0;
    margin-left: auto;
    margin-block: -10px;
    /* Explicit width AND height, not min-*: a flex item stretched on one axis with
       border-radius 50% renders as an ellipse, which no size assertion catches. */
    width: 32px;
    height: 32px;
    align-self: center;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    line-height: 1;
    border: 1px solid var(--text-dim);
    border-radius: 50%;
    background: none;
    color: var(--text-dim);
    font-size: 0.75rem;
  }
  /* Every percentage gets the width of its longest value ("100%"), so nothing on the line
     shifts as a figure crosses from one digit to two. */
  .num {
    display: inline-block;
    min-width: 4ch;
    text-align: right;
  }
  .ram {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .detail {
    opacity: 0.75;
  }
  /* The headroom figure carries the colour: it is the one number that answers "can I start
     something now", so it is what the eye should be drawn to when it turns. */
  .head {
    font-weight: 600;
    color: var(--text);
  }
  [data-band='warn'] .head { color: var(--warn); }
  [data-band='alert'] .head { color: var(--danger); }
</style>
