const WINDOW_MS = 60_000;
export const UNAUTHENTICATED_PER_ADDRESS = 8;
export const UNAUTHENTICATED_TOTAL = 32;
export const HANDSHAKES_PER_MINUTE = 20;
// Past this many addresses in the rate table, the ones idle for a minute are swept.
const SWEEP_AT = 1024;

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

// Who opened a socket on the phone port. Every peer of a loopback listener is local, so the
// client is the one a local proxy (tailscale serve, Funnel, a reverse proxy) names in
// x-forwarded-for, its last hop being the one that proxy saw. A loopback peer naming nobody is
// null: one address shared by every client behind it, which a per-address cap would lock out.
export function clientAddress(peer: string, forwardedFor: string | undefined): string | null {
  if (!LOOPBACK.test(peer)) return peer;
  const last = (forwardedFor ?? '').split(',').map((hop) => hop.trim()).filter(Boolean).at(-1);
  return last ?? null;
}

export type Admission = { ok: true; release: () => void; authenticated: () => void } | { ok: false; reason: 'address' | 'rate' };

interface Entry {
  address: string | null;
  evict: () => void;
}

// The bounds on sockets that have proven nothing yet: so many per client address, so many opened
// a minute per address, and so many in all. When all are taken the oldest is closed rather than
// the newcomer, so strangers holding every slot cannot keep the owner out. A session that
// authenticated leaves every count.
export class PhoneAdmission {
  // Insertion order is age order.
  private readonly pending = new Set<Entry>();
  private readonly perAddressCount = new Map<string, number>();
  private readonly opened = new Map<string, number[]>();
  private readonly perAddress: number;
  private readonly total: number;
  private readonly handshakesPerMinute: number;
  private readonly now: () => number;

  constructor(opts: { now: () => number; perAddress?: number; total?: number; handshakesPerMinute?: number }) {
    this.now = opts.now;
    this.perAddress = opts.perAddress ?? UNAUTHENTICATED_PER_ADDRESS;
    this.total = opts.total ?? UNAUTHENTICATED_TOTAL;
    this.handshakesPerMinute = opts.handshakesPerMinute ?? HANDSHAKES_PER_MINUTE;
  }

  admit(address: string | null, evict: () => void): Admission {
    if (address !== null) {
      if ((this.perAddressCount.get(address) ?? 0) >= this.perAddress) return { ok: false, reason: 'address' };
      const now = this.now();
      if (this.opened.size > SWEEP_AT) this.sweep(now);
      const recent = (this.opened.get(address) ?? []).filter((t) => now - t < WINDOW_MS);
      if (recent.length >= this.handshakesPerMinute) {
        this.opened.set(address, recent);
        return { ok: false, reason: 'rate' };
      }
      recent.push(now);
      this.opened.set(address, recent);
    }
    if (this.pending.size >= this.total) {
      const oldest = this.pending.values().next().value!;
      this.remove(oldest);
      oldest.evict();
    }
    const entry: Entry = { address, evict };
    this.pending.add(entry);
    if (address !== null) this.perAddressCount.set(address, (this.perAddressCount.get(address) ?? 0) + 1);
    const leave = () => this.remove(entry);
    return { ok: true, release: leave, authenticated: leave };
  }

  private remove(entry: Entry): void {
    if (!this.pending.delete(entry) || entry.address === null) return;
    const left = (this.perAddressCount.get(entry.address) ?? 1) - 1;
    if (left > 0) this.perAddressCount.set(entry.address, left);
    else this.perAddressCount.delete(entry.address);
  }

  private sweep(now: number): void {
    for (const [address, times] of this.opened) {
      if (times.every((t) => now - t >= WINDOW_MS)) this.opened.delete(address);
    }
  }
}
