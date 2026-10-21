import { readFile } from 'node:fs/promises';
import type { MachineStats } from '@perch/contracts';
import type { SystemStatsPort } from '../ports/system-stats-port';

export type TextFileReader = (path: string) => Promise<string>;

const CGROUP_ROOT = '/sys/fs/cgroup';

const readText: TextFileReader = (path) => readFile(path, 'utf8');

interface CpuSample {
  busy: number;
  total: number;
}

function parseCpuSample(stat: string): CpuSample | null {
  const line = stat.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some(Number.isNaN)) return null;
  const total = fields.reduce((sum, n) => sum + n, 0);
  // idle + iowait: time the CPU had nothing to run, however it was accounted.
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  return { busy: total - idle, total };
}

function parseMeminfo(meminfo: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of meminfo.split('\n')) {
    const match = /^(\w+):\s+(\d+) kB$/.exec(line.trim());
    if (match?.[1]) values.set(match[1], Number(match[2]) * 1024);
  }
  return values;
}

// "some avg10=1.23 avg60=… " — the share of the last 10s in which at least one task was
// stalled on memory. Unlike a usage ratio it ignores reclaimable cache, so it only moves
// when reclaim is actually costing time.
function parseStall(pressure: string): number | undefined {
  const match = /^some\s+avg10=([\d.]+)/m.exec(pressure);
  return match ? Number(match[1]) : undefined;
}

// Both memory.stat and memory.events are flat "<key> <value>" tables.
function parseKeyedCounters(raw: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of raw.split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && value !== undefined && /^\d+$/.test(value)) values.set(key, Number(value));
  }
  return values;
}

function parseLimit(raw: string): number | null {
  const value = raw.trim();
  if (value === 'max') return null;
  const bytes = Number(value);
  return Number.isFinite(bytes) ? bytes : null;
}

// Reads the machine's load from /proc and the cgroup v2 filesystem. Linux-only by
// construction: everywhere else `read` yields null and the agent sends no stats at all,
// rather than a half-true reading assembled from portable APIs.
export class ProcSystemStats implements SystemStatsPort {
  private previous: CpuSample | null = null;

  constructor(
    private readonly read_: TextFileReader = readText,
    private readonly platform: string = process.platform,
  ) {}

  async read(): Promise<MachineStats | null> {
    if (this.platform !== 'linux') return null;

    const cpuPercent = await this.sampleCpu();
    if (cpuPercent === null) return null;

    let meminfo: Map<string, number>;
    try {
      meminfo = parseMeminfo(await this.read_('/proc/meminfo'));
    } catch {
      return null;
    }
    const total = meminfo.get('MemTotal');
    const available = meminfo.get('MemAvailable');
    if (total === undefined || available === undefined) return null;

    const swapTotal = meminfo.get('SwapTotal') ?? 0;
    const swapFree = meminfo.get('SwapFree') ?? 0;

    return {
      cpuPercent,
      memory: { usedBytes: total - available, totalBytes: total },
      swapUsedBytes: swapTotal - swapFree,
      ...((await this.readLimit()) ?? {}),
    };
  }

  // CPU usage is a delta, so the first sample only primes the next one.
  private async sampleCpu(): Promise<number | null> {
    let sample: CpuSample | null;
    try {
      sample = parseCpuSample(await this.read_('/proc/stat'));
    } catch {
      return null;
    }
    if (!sample) return null;

    const previous = this.previous;
    this.previous = sample;
    if (!previous) return null;

    const window = sample.total - previous.total;
    if (window <= 0) return null;
    return ((sample.busy - previous.busy) / window) * 100;
  }

  private async readLimit(): Promise<Pick<MachineStats, 'limit'> | null> {
    let cgroup: string;
    try {
      // cgroup v2: a single `0::<path>` line, relative to the cgroup mount point.
      cgroup = (await this.read_('/proc/self/cgroup')).trim().replace(/^0::/, '');
    } catch {
      return null;
    }

    // The cap that binds the agent usually sits on an ancestor (the per-user slice), not on
    // the agent's own cgroup. Walking up finds it without hardcoding a uid or unit name.
    const segments = cgroup.split('/').filter(Boolean);
    for (let depth = segments.length; depth >= 0; depth -= 1) {
      const dir = [CGROUP_ROOT, ...segments.slice(0, depth)].join('/');
      const [high, max] = await Promise.all([
        this.readNumber(`${dir}/memory.high`),
        this.readNumber(`${dir}/memory.max`),
      ]);
      // memory.high throttles before memory.max kills, so the lower one is the real ceiling.
      const totalBytes = Math.min(...[high, max].filter((n): n is number => n !== null));
      if (!Number.isFinite(totalBytes)) continue;

      const usedBytes = await this.readNumber(`${dir}/memory.current`);
      if (usedBytes === null) continue;

      const stallPercent = await this.readStall(`${dir}/memory.pressure`);
      const reclaimableBytes = await this.readReclaimable(`${dir}/memory.stat`);
      const oomKills = await this.readCounter(`${dir}/memory.events`, 'oom_kill');
      return {
        limit: {
          usedBytes,
          totalBytes,
          ...(stallPercent !== undefined && { stallPercent }),
          // Only a real byte value is a kill line; an uncapped cgroup reads the literal
          // "max", and reporting that as a ceiling would make the client's headroom fiction.
          ...(max !== null && { maxBytes: max }),
          ...(reclaimableBytes !== undefined && { reclaimableBytes }),
          ...(oomKills !== undefined && { oomKills }),
        },
      };
    }
    return null;
  }

  // Cache and reclaimable slab, less mapped file pages: those are reclaimable in principle
  // but are the working set of running programs, so counting them as free overstates what a
  // new task can actually take.
  private async readReclaimable(path: string): Promise<number | undefined> {
    let counters: Map<string, number>;
    try {
      counters = parseKeyedCounters(await this.read_(path));
    } catch {
      return undefined;
    }
    const file = counters.get('file');
    const slab = counters.get('slab_reclaimable');
    if (file === undefined || slab === undefined) return undefined;
    return Math.max(0, file - (counters.get('file_mapped') ?? 0) + slab);
  }

  private async readCounter(path: string, key: string): Promise<number | undefined> {
    try {
      return parseKeyedCounters(await this.read_(path)).get(key);
    } catch {
      return undefined;
    }
  }

  private async readNumber(path: string): Promise<number | null> {
    try {
      return parseLimit(await this.read_(path));
    } catch {
      return null;
    }
  }

  private async readStall(path: string): Promise<number | undefined> {
    try {
      return parseStall(await this.read_(path));
    } catch {
      return undefined;
    }
  }
}
