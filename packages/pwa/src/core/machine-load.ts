import type { MachineStats } from '@perch/contracts';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

// Stall thresholds on the kernel's PSI `some avg10` — the share of the last 10s in which
// at least one task waited on memory. Anything above a few percent is already felt.
const WARN_STALL_PERCENT = 10;
const ALERT_STALL_PERCENT = 40;

// Headroom thresholds on the room left before the slice slows down. Sized to what actually
// gets launched here — a test suite wants 1-2G, a build more — so amber means "a build might
// now hurt", not "the number looks big".
export const HEADROOM_WARN_BYTES = 3 * GIB;
export const HEADROOM_ALERT_BYTES = GIB / 2;

export type LoadBand = 'ok' | 'warn' | 'alert';

export interface LoadDescription {
  cpu: string;
  // Room before the machine slows down — the headline, and the figure the colour tracks.
  slowLabel: string;
  // Room before the kernel kills something. Empty when there is no separate kill line.
  killLabel: string;
  // Passed through so the help panel explains the same reading the strip coloured on.
  killsSinceConnect: number;
  band: LoadBand;
  capped: boolean;
}

export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)}G`;
  return `${Math.round(bytes / MIB)}M`;
}

export interface Headroom {
  slow: number;
  kill?: number;
}

// Cache the kernel can drop for free counts as available, never as used, so both figures are
// measured from the footprint left once it is gone. Crossing memory.high (`totalBytes`) only
// drops cache while there is cache to drop; the slowdown starts when the footprint reaches it
// and every allocation has to swap something out. memory.max is where the kernel kills.
export function headroomBytes(stats: MachineStats): Headroom {
  const { memory, limit } = stats;
  // MemAvailable already leaves cache out, so it answers the same question at machine scope.
  if (!limit) return { slow: Math.max(0, memory.totalBytes - memory.usedBytes) };
  const footprint = limit.usedBytes - (limit.reclaimableBytes ?? 0);
  const slow = Math.max(0, limit.totalBytes - footprint);
  if (limit.maxBytes === undefined || limit.maxBytes <= limit.totalBytes) return { slow };
  return { slow, kill: Math.max(0, limit.maxBytes - footprint) };
}

function stallBand(stallPercent: number): LoadBand {
  if (stallPercent >= ALERT_STALL_PERCENT) return 'alert';
  if (stallPercent >= WARN_STALL_PERCENT) return 'warn';
  return 'ok';
}

function headroomBand(bytes: number): LoadBand {
  if (bytes >= HEADROOM_WARN_BYTES) return 'ok';
  if (bytes >= HEADROOM_ALERT_BYTES) return 'warn';
  return 'alert';
}

const SEVERITY: Record<LoadBand, number> = { ok: 0, warn: 1, alert: 2 };
const worst = (a: LoadBand, b: LoadBand): LoadBand => (SEVERITY[a] >= SEVERITY[b] ? a : b);

// Three independent signals, worst wins. Headroom is the prediction; the PSI stall is what
// is being felt right now; a kill that already happened is the one thing the live reading
// can never show, because the memory it freed is what makes the reading look healthy again.
export function loadBand(stats: MachineStats, killsSinceConnect = 0): LoadBand {
  const band = worst(headroomBand(headroomBytes(stats).slow), stallBand(stats.limit?.stallPercent ?? 0));
  return killsSinceConnect > 0 ? 'alert' : band;
}

export function describeLoad(stats: MachineStats, killsSinceConnect = 0): LoadDescription {
  const headroom = headroomBytes(stats);
  return {
    cpu: `${Math.min(100, Math.max(0, Math.round(stats.cpuPercent)))}%`,
    slowLabel: formatBytes(headroom.slow),
    killLabel: headroom.kill === undefined ? '' : formatBytes(headroom.kill),
    killsSinceConnect,
    band: loadBand(stats, killsSinceConnect),
    capped: stats.limit !== undefined,
  };
}
