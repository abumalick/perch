import type { MachineStats } from '@perch/contracts';

// The machine's current CPU/memory load, as shown by the PWA's load strip.
export interface SystemStatsPort {
  // Null when no reading is available: an unsupported platform, unreadable counters, or
  // the very first call (CPU usage is a delta between two samples, so it needs a
  // predecessor). Callers treat null as "nothing to report this tick".
  read(): Promise<MachineStats | null>;
}
