import type { DeviceGate } from '../ports/device-gate-port';
import { enrolmentMode, standingOf, type DeviceRoster } from './device-roster';

const WINDOW_MS = 60_000;
export const DISK_READS_AT_ONCE = 4;
export const DISK_READS_PER_MINUTE = 10;

// What a stranger on the phone port can make the agent read from disk (the roster on message 1,
// the pairing file at `auth`): so many at once and so many a minute, refused past either without
// reading.
export class DiskReadLimiter {
  private running = 0;
  private started: number[] = [];

  constructor(
    private readonly now: () => number,
    private readonly concurrent = DISK_READS_AT_ONCE,
    private readonly perMinute = DISK_READS_PER_MINUTE,
  ) {}

  async run<T>(read: () => Promise<T>): Promise<T | 'limited'> {
    const now = this.now();
    this.started = this.started.filter((t) => now - t < WINDOW_MS);
    if (this.running >= this.concurrent || this.started.length >= this.perMinute) return 'limited';
    this.started.push(now);
    this.running++;
    try {
      return await read();
    } finally {
      this.running--;
    }
  }
}

class DiskReadLimited extends Error {
  constructor() {
    super('disk reads limited');
  }
}

async function limited<T>(limiter: DiskReadLimiter, read: () => Promise<T>): Promise<T> {
  const result = await limiter.run(read);
  if (result === 'limited') throw new DiskReadLimited();
  return result;
}

// The device gate a direct socket uses. A key enrolled as of the last roster read (`roster`) is
// answered from it, so the owner's phones never wait on the limiter; any other check, and every
// pairing secret spent, goes through it. A limited read fails as an unreadable roster does, which
// the connection already answers.
export function limitedDevices(devices: DeviceGate, limiter: DiskReadLimiter, roster: () => DeviceRoster | null): DeviceGate {
  return {
    check: async (x25519) => {
      const known = roster();
      if (known && standingOf(known, x25519) === 'enrolled') return { standing: 'enrolled', enrolment: enrolmentMode(known) };
      return limited(limiter, () => devices.check(x25519));
    },
    enrol: (device, via) => devices.enrol(device, via),
    redeemPairing: (secret, device) => limited(limiter, () => devices.redeemPairing(secret, device)),
    burnPairing: (secret, device) => devices.burnPairing(secret, device),
  };
}
