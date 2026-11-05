const WINDOW_MS = 60_000;
export const UNAUTHENTICATED_PER_ADDRESS = 8;
export const UNAUTHENTICATED_TOTAL = 32;
export const HANDSHAKES_PER_MINUTE = 20;
// An IPv6 /56 is counted too, at three times the /64 caps: a host with a routed /48 has 65 536
// /64s, but far fewer /56s, while a household's /56 still has room for several phones.
export const UNAUTHENTICATED_PER_PREFIX = 3 * UNAUTHENTICATED_PER_ADDRESS;
export const HANDSHAKES_PER_MINUTE_PER_PREFIX = 3 * HANDSHAKES_PER_MINUTE;
// Sockets that came through Funnel (the public internet) wait in a pool of their own, so a public
// flood evicts only public handshakes, never a tailnet one.
export const UNAUTHENTICATED_PUBLIC_TOTAL = 16;
// Past this many addresses in the rate table, the ones idle for a minute are swept, at most once
// a second so an address flood does not make every admit walk the table.
const SWEEP_AT = 1024;
const SWEEP_EVERY_MS = 1000;

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

// Who opened a socket on the phone port. Every peer of a loopback listener is local, so the
// client is the one a local proxy (tailscale serve, Funnel, a reverse proxy) names in
// x-forwarded-for, its last hop being the one that proxy saw. A loopback peer naming nobody is
// null: one address shared by every client behind it, which a per-address cap would lock out.
export function clientAddress(peer: string, forwardedFor: string | undefined): string | null {
  if (!LOOPBACK.test(peer)) return subscriber(peer);
  const last = (forwardedFor ?? '').split(',').map((hop) => hop.trim()).filter(Boolean).at(-1);
  return last === undefined ? null : subscriber(last);
}

// tailscaled sets Tailscale-Funnel-Request on a request that came through Funnel and drops one a
// client sent, so the header is believed only from a loopback peer, like x-forwarded-for.
export function isFunnelRequest(peer: string, header: string | undefined): boolean {
  return LOOPBACK.test(peer) && header !== undefined;
}

// The /56 a /64 key (`a:b:c:d::/64`) sits in, counted beside it.
function widePrefix(address: string): string | null {
  const match = /^([0-9a-f]+:[0-9a-f]+:[0-9a-f]+):([0-9a-f]+)::\/64$/.exec(address);
  if (!match) return null;
  return `${match[1]}:${(Number.parseInt(match[2]!, 16) & 0xff00).toString(16)}::/56`;
}

// An IPv6 client is counted by its /64: a single subscriber is handed one whole, so counting
// each address would give one client endless fresh ones.
function subscriber(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1]!;
  if (!address.includes(':') || address.includes('.')) return address;
  const [head, tail, ...rest] = address.split('::');
  if (rest.length > 0) return address;
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const missing = 8 - front.length - back.length;
  if (tail === undefined ? front.length !== 8 : missing < 1) return address;
  const groups = [...front, ...Array<string>(missing).fill('0'), ...back];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return address;
  return `${groups.slice(0, 4).map((g) => Number.parseInt(g, 16).toString(16)).join(':')}::/64`;
}

export type Pool = 'tailnet' | 'public';

export type Admission = { ok: true; release: () => void; authenticated: () => void } | { ok: false; reason: 'address' | 'rate' };

interface Entry {
  // The counted keys: the address, then its /56 for an IPv6 one.
  keys: string[];
  pool: Pool;
  evict: () => void;
}

// The bounds on sockets that have proven nothing yet: so many per client address, so many opened
// a minute per address, and so many in all. When all are taken the oldest is closed rather than
// the newcomer, so strangers holding every slot cannot keep the owner out. A session that
// authenticated leaves every count. Funnel requests fill a pool of their own, with its own total.
export class PhoneAdmission {
  // Insertion order is age order.
  private readonly pending: Record<Pool, Set<Entry>> = { tailnet: new Set(), public: new Set() };
  private readonly perAddressCount = new Map<string, number>();
  private readonly opened = new Map<string, number[]>();
  private lastSweep = -Infinity;
  private readonly perAddress: number;
  private readonly totals: Record<Pool, number>;
  private readonly handshakesPerMinute: number;
  private readonly now: () => number;

  constructor(opts: { now: () => number; perAddress?: number; total?: number; publicTotal?: number; handshakesPerMinute?: number }) {
    this.now = opts.now;
    this.perAddress = opts.perAddress ?? UNAUTHENTICATED_PER_ADDRESS;
    this.totals = { tailnet: opts.total ?? UNAUTHENTICATED_TOTAL, public: opts.publicTotal ?? UNAUTHENTICATED_PUBLIC_TOTAL };
    this.handshakesPerMinute = opts.handshakesPerMinute ?? HANDSHAKES_PER_MINUTE;
  }

  admit(address: string | null, evict: () => void, pool: Pool = 'tailnet'): Admission {
    const wide = address === null ? null : widePrefix(address);
    const keys = address === null ? [] : wide === null ? [address] : [address, wide];
    const caps = (i: number) => (i === 0 ? [this.perAddress, this.handshakesPerMinute] : [UNAUTHENTICATED_PER_PREFIX, HANDSHAKES_PER_MINUTE_PER_PREFIX]);
    if (keys.some((key, i) => (this.perAddressCount.get(key) ?? 0) >= caps(i)[0]!)) return { ok: false, reason: 'address' };
    if (keys.length > 0) {
      const now = this.now();
      if (this.opened.size > SWEEP_AT && now - this.lastSweep >= SWEEP_EVERY_MS) this.sweep(now);
      const recent = keys.map((key) => (this.opened.get(key) ?? []).filter((t) => now - t < WINDOW_MS));
      if (recent.some((times, i) => times.length >= caps(i)[1]!)) {
        keys.forEach((key, i) => this.opened.set(key, recent[i]!));
        return { ok: false, reason: 'rate' };
      }
      keys.forEach((key, i) => this.opened.set(key, [...recent[i]!, now]));
    }
    const pending = this.pending[pool];
    if (pending.size >= this.totals[pool]) {
      const oldest = pending.values().next().value!;
      this.remove(oldest);
      oldest.evict();
    }
    const entry: Entry = { keys, pool, evict };
    pending.add(entry);
    for (const key of keys) this.perAddressCount.set(key, (this.perAddressCount.get(key) ?? 0) + 1);
    const leave = () => this.remove(entry);
    return { ok: true, release: leave, authenticated: leave };
  }

  private remove(entry: Entry): void {
    if (!this.pending[entry.pool].delete(entry)) return;
    for (const key of entry.keys) {
      const left = (this.perAddressCount.get(key) ?? 1) - 1;
      if (left > 0) this.perAddressCount.set(key, left);
      else this.perAddressCount.delete(key);
    }
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [address, times] of this.opened) {
      if (times.every((t) => now - t >= WINDOW_MS)) this.opened.delete(address);
    }
  }
}
