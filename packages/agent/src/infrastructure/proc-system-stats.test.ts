import { describe, it, expect } from 'vitest';
import { ProcSystemStats } from './proc-system-stats';

const MEMINFO = [
  'MemTotal:       30408704 kB',
  'MemFree:         2900000 kB',
  'MemAvailable:   12000000 kB',
  'SwapTotal:      16000000 kB',
  'SwapFree:        6000000 kB',
].join('\n');

const CGROUP = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/perch-agent.service\n';
const USER_SLICE = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service';
const APP_SLICE = `${USER_SLICE}/app.slice/perch-agent.service`;

// Busy = user + system; the second sample adds 100 busy ticks and 100 idle ticks, so the
// window is exactly 50% busy.
const STAT_1 = 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\n';
const STAT_2 = 'cpu  150 0 150 900 0 0 0 0 0 0\ncpu0 150 0 150 900 0 0 0 0 0 0\n';

function files(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    '/proc/stat': STAT_1,
    '/proc/meminfo': MEMINFO,
    '/proc/self/cgroup': CGROUP,
    [`${APP_SLICE}/memory.high`]: 'max\n',
    [`${APP_SLICE}/memory.max`]: 'max\n',
    [`${USER_SLICE}/memory.high`]: '18253611008\n',
    [`${USER_SLICE}/memory.max`]: '21474836480\n',
    [`${USER_SLICE}/memory.current`]: '16451035136\n',
    [`${USER_SLICE}/memory.stat`]: [
      'anon 10307921920',
      'file 3006477312',
      'file_mapped 706740224',
      'slab_reclaimable 2317089024',
      'slab_unreclaimable 37748736',
    ].join('\n'),
    [`${USER_SLICE}/memory.events`]: 'low 0\nhigh 121095666\nmax 7537450\noom 40\noom_kill 7\n',
    [`${USER_SLICE}/memory.pressure`]:
      'some avg10=1.23 avg60=0.40 avg300=0.10 total=17279464887\nfull avg10=0.50 avg60=0.20 avg300=0.05 total=16364543226\n',
    ...overrides,
  };
}

function statsFrom(table: Record<string, string>) {
  const current = { ...table };
  const reader = async (path: string) => {
    const value = current[path];
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return value;
  };
  return {
    stats: new ProcSystemStats(reader, 'linux'),
    // Advance /proc/stat so the next read has a delta to measure.
    tick: () => {
      current['/proc/stat'] = STAT_2;
    },
  };
}

describe('ProcSystemStats', () => {
  it('has no reading until it has two CPU samples', async () => {
    const { stats } = statsFrom(files());
    expect(await stats.read()).toBeNull();
  });

  it('reports CPU, memory, swap and the cgroup limit', async () => {
    const { stats, tick } = statsFrom(files());
    await stats.read();
    tick();
    expect(await stats.read()).toEqual({
      cpuPercent: 50,
      memory: { usedBytes: (30408704 - 12000000) * 1024, totalBytes: 30408704 * 1024 },
      swapUsedBytes: (16000000 - 6000000) * 1024,
      limit: {
        usedBytes: 16451035136,
        totalBytes: 18253611008,
        stallPercent: 1.23,
        maxBytes: 21474836480,
        reclaimableBytes: 3_006_477_312 - 706_740_224 + 2_317_089_024,
        oomKills: 7,
      },
    });
  });

  // The agent's own cgroup carries no cap; the limit that binds it sits further up the
  // tree. Walking ancestors is what finds it without hardcoding a uid or a unit name.
  it('walks up to the nearest ancestor that sets a limit', async () => {
    const { stats, tick } = statsFrom(files());
    await stats.read();
    tick();
    const reading = await stats.read();
    expect(reading?.limit?.totalBytes).toBe(18253611008);
  });

  // memory.high throttles before memory.max kills, so the lower of the two is the ceiling
  // the machine actually runs against.
  it('takes the lower of memory.high and memory.max', async () => {
    const { stats, tick } = statsFrom(
      files({ [`${USER_SLICE}/memory.high`]: '21474836480\n', [`${USER_SLICE}/memory.max`]: '18253611008\n' }),
    );
    await stats.read();
    tick();
    expect((await stats.read())?.limit?.totalBytes).toBe(18253611008);
  });

  it('reports no limit on a machine with no cap', async () => {
    const { stats, tick } = statsFrom(
      files({ [`${USER_SLICE}/memory.high`]: 'max\n', [`${USER_SLICE}/memory.max`]: 'max\n' }),
    );
    await stats.read();
    tick();
    const reading = await stats.read();
    expect(reading?.limit).toBeUndefined();
    expect(reading?.cpuPercent).toBe(50);
  });

  it('reports no limit when the cgroup files are unreadable', async () => {
    const table = files();
    delete table['/proc/self/cgroup'];
    const { stats, tick } = statsFrom(table);
    await stats.read();
    tick();
    expect((await stats.read())?.limit).toBeUndefined();
  });

  it('omits the stall figure when pressure is unavailable', async () => {
    const table = files();
    delete table[`${USER_SLICE}/memory.pressure`];
    const { stats, tick } = statsFrom(table);
    await stats.read();
    tick();
    expect((await stats.read())?.limit).toEqual({
      usedBytes: 16451035136,
      totalBytes: 18253611008,
      maxBytes: 21474836480,
      reclaimableBytes: 3_006_477_312 - 706_740_224 + 2_317_089_024,
      oomKills: 7,
    });
  });

  it('has no reading when the memory counters are unreadable', async () => {
    const table = files();
    delete table['/proc/meminfo'];
    const { stats, tick } = statsFrom(table);
    await stats.read();
    tick();
    expect(await stats.read()).toBeNull();
  });

  // Linux-only by construction: /proc does not exist elsewhere, and a partial reading
  // would be worse than none.
  it('has no reading off Linux', async () => {
    const stats = new ProcSystemStats(async () => MEMINFO, 'darwin');
    expect(await stats.read()).toBeNull();
    expect(await stats.read()).toBeNull();
  });

  // A counter that goes backwards (a suspended machine, a wrapped counter) would divide by
  // a non-positive window; report nothing rather than a nonsense percentage.
  it('has no reading when the CPU counters do not advance', async () => {
    const { stats } = statsFrom(files());
    await stats.read();
    expect(await stats.read()).toBeNull();
  });

  // The kill line is memory.max; `totalBytes` stays min(high, max) because that is the
  // throttle line the strip already shows and the machine is normally pinned against.
  it('reports the kill line separately from the throttle line', async () => {
    const { stats, tick } = statsFrom(files());
    await stats.read();
    tick();
    const reading = await stats.read();
    expect(reading?.limit?.totalBytes).toBe(18_253_611_008);
    expect(reading?.limit?.maxBytes).toBe(21_474_836_480);
  });

  // Mapped pages are reclaimable in principle but are the working set of running programs;
  // counting them as free headroom overstates it, and this figure exists not to overstate.
  it('reports reclaimable memory as cache plus reclaimable slab, less mapped pages', async () => {
    const { stats, tick } = statsFrom(files());
    await stats.read();
    tick();
    const reading = await stats.read();
    expect(reading?.limit?.reclaimableBytes).toBe(3_006_477_312 - 706_740_224 + 2_317_089_024);
  });

  it('reports the cumulative OOM kill count', async () => {
    const { stats, tick } = statsFrom(files());
    await stats.read();
    tick();
    expect((await stats.read())?.limit?.oomKills).toBe(7);
  });

  // Every one of these is best-effort: a kernel that does not expose them must still yield a
  // reading, so the strip degrades to its old shape rather than vanishing.
  it('still reports a limit when the headroom files are missing', async () => {
    const table = files();
    delete table[`${USER_SLICE}/memory.stat`];
    delete table[`${USER_SLICE}/memory.events`];
    const { stats, tick } = statsFrom(table);
    await stats.read();
    tick();
    const reading = await stats.read();
    expect(reading?.limit?.totalBytes).toBe(18_253_611_008);
    expect(reading?.limit?.reclaimableBytes).toBeUndefined();
    expect(reading?.limit?.oomKills).toBeUndefined();
  });

  // An uncapped cgroup sets memory.max to the literal "max": there is no kill line to
  // measure against, and reporting one would make headroom fiction.
  it('omits the kill line when the cgroup sets no hard limit', async () => {
    const { stats, tick } = statsFrom(files({ [`${USER_SLICE}/memory.max`]: 'max\n' }));
    await stats.read();
    tick();
    expect((await stats.read())?.limit?.maxBytes).toBeUndefined();
  });
});
