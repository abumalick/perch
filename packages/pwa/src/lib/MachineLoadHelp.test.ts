import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import MachineLoadHelp from './MachineLoadHelp.svelte';
import { describeLoad } from '../core/machine-load';
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

const show = (s: MachineStats = stats, kills = 0) =>
  render(MachineLoadHelp, { props: { load: describeLoad(s, kills), onClose: () => undefined } });

describe('MachineLoadHelp', () => {
  // The panel explains THIS machine's reading, so every figure it discusses must be the one
  // the strip is showing — it takes the same LoadDescription rather than re-deriving.
  it('explains the machine its own live figures', () => {
    show();
    const panel = screen.getByTestId('machine-load-help');
    expect(panel.textContent).toContain('6.0G left');
    expect(screen.getByTestId('help-row-kill').textContent).toContain('9.0G before kill');
  });

  // The thresholds are knobs; hard-coding "3G" in the prose would quietly lie the day one
  // is retuned.
  it('states the colour thresholds from the constants', () => {
    show();
    expect(screen.getByTestId('machine-load-help').textContent).toMatch(/3\.0G/);
    expect(screen.getByTestId('machine-load-help').textContent).toMatch(/512M/);
  });

  // No separate kill line to name on an uncapped machine; naming one anyway would print a
  // confident wrong number in the one place meant to remove confusion.
  it('omits the kill row when there is no kill line', () => {
    show({ ...stats, limit: undefined });
    expect(screen.queryByTestId('help-row-kill')).toBeNull();
  });

  // Only worth saying when it happened; otherwise it is noise on a panel meant to calm.
  it('mentions kills only when some happened since connecting', () => {
    const { unmount } = show(stats, 0);
    expect(screen.queryByTestId('help-row-kills')).toBeNull();
    unmount();
    show(stats, 2);
    expect(screen.getByTestId('help-row-kills').textContent).toContain('2');
  });

  // The strip's raw figures are aria-hidden on purpose; the prose that explains them is the
  // part that genuinely reads well aloud.
  it('is a labelled dialog the screen reader can reach', () => {
    show();
    const panel = screen.getByTestId('machine-load-help');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('aria-hidden')).toBeNull();
  });
});
