import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  loadBand,
  describeLoad,
  headroomBytes,
  HEADROOM_WARN_BYTES,
  HEADROOM_ALERT_BYTES,
} from './machine-load';
import type { MachineStats } from '@perch/contracts';

const stats: MachineStats = {
  cpuPercent: 12.4,
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

describe('formatBytes', () => {
  it('renders GiB with one decimal', () => {
    expect(formatBytes(16_451_035_136)).toBe('15.3G');
    expect(formatBytes(18_253_611_008)).toBe('17.0G');
  });

  it('drops to MiB below a gigabyte, so a small figure is not all zeroes', () => {
    expect(formatBytes(524_288_000)).toBe('500M');
    expect(formatBytes(0)).toBe('0M');
  });
});

describe('headroomBytes', () => {
  // Cache the kernel can drop for free counts as available, never as used: the footprint is
  // what is left once it is gone, and the room is measured from there.
  const footprint = 16_451_035_136 - 4_617_089_024;

  it('measures the room before the slice slows down from the footprint', () => {
    expect(headroomBytes(stats).slow).toBe(18_253_611_008 - footprint);
  });

  it('measures the room before a kill from the same footprint', () => {
    expect(headroomBytes(stats).kill).toBe(21_474_836_480 - footprint);
  });

  // No cap means no cgroup lines; MemAvailable already leaves cache out, so it answers the
  // same question at machine scope.
  it('falls back to available physical memory when the machine is uncapped', () => {
    expect(headroomBytes({ ...stats, limit: undefined })).toEqual({ slow: 31_138_512_896 - 17_179_869_184 });
  });

  // Nothing slows the slice before it is killed when only memory.max is set, so there is a
  // single line and naming it twice would only add a number.
  it('reports one line when the kill line is also where it slows down', () => {
    const maxOnly = { ...stats, limit: { ...stats.limit!, totalBytes: 21_474_836_480 } };
    expect(headroomBytes(maxOnly)).toEqual({ slow: 21_474_836_480 - footprint });
  });

  it('reports one line when the agent sends no kill line', () => {
    expect(headroomBytes({ ...stats, limit: { ...stats.limit!, maxBytes: undefined } }).kill).toBeUndefined();
  });

  it('never reports negative room', () => {
    const over = { ...stats, limit: { ...stats.limit!, usedBytes: 99_000_000_000, reclaimableBytes: 0 } };
    expect(headroomBytes(over)).toEqual({ slow: 0, kill: 0 });
  });
});

describe('loadBand', () => {
  // The usage ratio counts reclaimable page cache, so a healthy machine sits near its
  // limit indefinitely. Colouring on it would mean a permanent warning.
  it('stays calm at high usage while headroom is wide and nothing is stalling', () => {
    expect(loadBand({ ...stats, limit: { ...stats.limit!, usedBytes: 18_000_000_000 } })).toBe('ok');
  });

  it('warns once memory stalls appear, and alerts when they are severe', () => {
    expect(loadBand({ ...stats, limit: { ...stats.limit!, stallPercent: 9.9 } })).toBe('ok');
    expect(loadBand({ ...stats, limit: { ...stats.limit!, stallPercent: 10 } })).toBe('warn');
    expect(loadBand({ ...stats, limit: { ...stats.limit!, stallPercent: 40 } })).toBe('alert');
  });

  // The headroom thresholds are the point of the feature: a shrinking cushion colours the
  // strip before any stall has been felt.
  it('colours on headroom alone, before a stall is measurable', () => {
    const at = (headroom: number) =>
      loadBand({
        ...stats,
        limit: { ...stats.limit!, stallPercent: 0, reclaimableBytes: 0, totalBytes: headroom, usedBytes: 0 },
      });
    expect(at(HEADROOM_WARN_BYTES + 1)).toBe('ok');
    expect(at(HEADROOM_WARN_BYTES - 1)).toBe('warn');
    expect(at(HEADROOM_ALERT_BYTES - 1)).toBe('alert');
  });

  // Two independent signals; whichever is worse wins, so a wide cushion cannot mask a stall
  // and a quiet PSI cannot mask an exhausted one.
  it('takes the worse of headroom and stall', () => {
    const wideButStalling = { ...stats, limit: { ...stats.limit!, stallPercent: 40 } };
    expect(loadBand(wideButStalling)).toBe('alert');
  });

  // A kill already happened this session. Nothing about the current reading can say that,
  // because the memory it freed is exactly what makes the reading look healthy again.
  it('alerts when the kill counter grew since the client connected', () => {
    expect(loadBand(stats, 0)).toBe('ok');
    expect(loadBand(stats, 1)).toBe('alert');
  });

  it('stays calm when the machine reports no stall figure', () => {
    expect(loadBand({ ...stats, limit: { ...stats.limit!, stallPercent: undefined } })).toBe('ok');
    expect(loadBand({ ...stats, limit: undefined })).toBe('ok');
  });
});

describe('describeLoad', () => {
  it('reports the room before slowing down and before a kill', () => {
    expect(describeLoad(stats)).toEqual({
      cpu: '12%',
      slowLabel: '6.0G',
      killLabel: '9.0G',
      killsSinceConnect: 0,
      band: 'ok',
      capped: true,
    });
  });

  it('reports a single figure on an uncapped machine', () => {
    expect(describeLoad({ ...stats, limit: undefined })).toMatchObject({
      slowLabel: '13.0G',
      killLabel: '',
      capped: false,
    });
  });

  it('rounds CPU to whole percent and clamps a noisy reading', () => {
    expect(describeLoad({ ...stats, cpuPercent: 0.4 }).cpu).toBe('0%');
    expect(describeLoad({ ...stats, cpuPercent: 100.7 }).cpu).toBe('100%');
    expect(describeLoad({ ...stats, cpuPercent: -1 }).cpu).toBe('0%');
  });

  it('carries the kill delta through to the band', () => {
    expect(describeLoad(stats, 2)).toMatchObject({ band: 'alert', killsSinceConnect: 2 });
  });
});
