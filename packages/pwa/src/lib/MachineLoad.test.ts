import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import MachineLoad from './MachineLoad.svelte';
import type { MachineStats } from '@perch/contracts';

const stats: MachineStats = {
  cpuPercent: 12,
  memory: { usedBytes: 17_179_869_184, totalBytes: 31_138_512_896 },
  swapUsedBytes: 9_771_384_832,
  limit: {
    usedBytes: 16_451_035_136,
    totalBytes: 18_253_611_008,
    stallPercent: 0,
    maxBytes: 21_474_836_480,
    reclaimableBytes: 4_617_089_024,
    oomKills: 7,
  },
};

describe('MachineLoad', () => {
  // Two figures and nothing else: the room before the machine slows down, then before a
  // kill. Svelte trims whitespace at an {#if} boundary, so the text is read as rendered.
  it('shows the room before slowing down and before a kill', () => {
    render(MachineLoad, { props: { stats } });
    expect(screen.getByTestId('machine-load-ram').textContent!.replace(/\s+/g, ' ').trim()).toBe(
      'RAM 6.0G left · 9.0G before kill',
    );
    expect(screen.getByTestId('machine-load').textContent).toContain('12%');
  });

  // A percentage growing from one digit to two would otherwise shove the whole line
  // sideways, which reads as flicker on a readout that refreshes every few seconds.
  it('keeps each percentage in a fixed-width slot', () => {
    render(MachineLoad, { props: { stats: { ...stats, cpuPercent: 6 } } });
    const cpu = screen.getByTestId('machine-load-cpu');
    expect(cpu.textContent).toBe('6%');
    expect(cpu.className).toContain('num');
  });

  it('carries the band so the colour tracks real memory stalls, not the percentage', () => {
    const { unmount } = render(MachineLoad, { props: { stats } });
    expect(screen.getByTestId('machine-load').dataset.band).toBe('ok');
    unmount();
    render(MachineLoad, {
      props: { stats: { ...stats, limit: { ...stats.limit!, stallPercent: 55 } } },
    });
    expect(screen.getByTestId('machine-load').dataset.band).toBe('alert');
  });

  it('names the machine only when asked to', () => {
    const { unmount } = render(MachineLoad, { props: { stats } });
    expect(screen.queryByTestId('machine-load-name')).toBeNull();
    unmount();
    render(MachineLoad, { props: { stats, name: 'mini' } });
    expect(screen.getByTestId('machine-load-name').textContent).toContain('mini');
  });

  it('shows a single figure on an uncapped machine', () => {
    render(MachineLoad, { props: { stats: { ...stats, limit: undefined } } });
    expect(screen.getByTestId('machine-load-headroom').textContent).toContain('13.0G');
    expect(screen.queryByTestId('machine-load-kill')).toBeNull();
  });

  it('headlines the room before slowing down and colours that element', () => {
    render(MachineLoad, { props: { stats } });
    const headroom = screen.getByTestId('machine-load-headroom');
    expect(headroom.textContent).toContain('6.0G');
    expect(screen.getByTestId('machine-load').dataset.band).toBe('ok');
  });

  // A shrinking cushion must colour the strip before any stall has been felt — that is the
  // whole point of the figure, since PSI only moves once reclaim is already costing time.
  it('colours on headroom alone while nothing is stalling', () => {
    render(MachineLoad, {
      props: {
        stats: { ...stats, limit: { ...stats.limit!, stallPercent: 0, reclaimableBytes: 0, usedBytes: 21_000_000_000 } },
      },
    });
    expect(screen.getByTestId('machine-load').dataset.band).toBe('alert');
  });

  // A kill already happened; the reading that follows looks healthy precisely because the
  // kill freed the memory, so only the counter can say so.
  it('alerts when the machine has taken a kill since connecting', () => {
    render(MachineLoad, { props: { stats, killsSinceConnect: 1 } });
    expect(screen.getByTestId('machine-load').dataset.band).toBe('alert');
  });

  it('offers a help button that opens the explanation', async () => {
    render(MachineLoad, { props: { stats } });
    expect(screen.queryByTestId('machine-load-help')).toBeNull();
    await fireEvent.click(screen.getByTestId('machine-load-help-open'));
    expect(screen.getByTestId('machine-load-help')).toBeInTheDocument();
  });

  it('closes the explanation again', async () => {
    render(MachineLoad, { props: { stats } });
    await fireEvent.click(screen.getByTestId('machine-load-help-open'));
    await fireEvent.click(screen.getByRole('button', { name: /done/i }));
    expect(screen.queryByTestId('machine-load-help')).toBeNull();
  });

  // The raw figures stay out of the screen reader's way — they say nothing useful by ear —
  // but a focusable button inside an aria-hidden subtree is unreachable, so the attribute
  // has to sit on the numbers rather than on the whole strip.
  it('hides the figures from the screen reader without hiding the button', () => {
    render(MachineLoad, { props: { stats } });
    expect(screen.getByTestId('machine-load').getAttribute('aria-hidden')).toBeNull();
    expect(screen.getByTestId('machine-load-figures').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('machine-load-help-open').getAttribute('aria-label')).toBeTruthy();
  });

  // The explanation is rendered from the same LoadDescription the strip drew, so the two
  // can never disagree about a figure.
  it('explains the figures the strip is showing', async () => {
    render(MachineLoad, { props: { stats, killsSinceConnect: 3 } });
    await fireEvent.click(screen.getByTestId('machine-load-help-open'));
    const panel = screen.getByTestId('machine-load-help');
    expect(panel.textContent).toContain('6.0G');
    expect(panel.textContent).toContain('9.0G');
    expect(screen.getByTestId('help-row-kills').textContent).toContain('3');
  });

  // A machine going offline drops its reading, so WorkspaceList stops rendering its strip
  // and the open explanation goes with it. Deliberate: the figures it was explaining are
  // gone, and a panel describing numbers that no longer exist is worse than no panel.
  it('takes the explanation down with the strip', async () => {
    const { unmount } = render(MachineLoad, { props: { stats } });
    await fireEvent.click(screen.getByTestId('machine-load-help-open'));
    expect(screen.getByTestId('machine-load-help')).toBeInTheDocument();
    unmount();
    expect(screen.queryByTestId('machine-load-help')).toBeNull();
  });
});
