// Challenge nonces already used, each until it would be refused as expired anyway. Expired ones
// are swept at most once a second: sweeping on every use walked the whole map per upgrade, so a
// flood cost the relay CPU quadratic in its rate. Insertion order is not expiry order (a nonce is
// used any time within its life), so a sweep cannot stop at the first live entry.
const SWEEP_EVERY_MS = 1_000;

export class SpentNonces {
  private lastSweep = -Infinity;

  constructor(private readonly spent: Map<string, number> = new Map()) {}

  // Records `nonce` as used until `expires`; false when it already was.
  use(nonce: string, expires: number, now: number): boolean {
    if (now - this.lastSweep >= SWEEP_EVERY_MS) {
      this.lastSweep = now;
      for (const [used, until] of this.spent) if (until <= now) this.spent.delete(used);
    }
    const until = this.spent.get(nonce);
    if (until !== undefined && until > now) return false;
    this.spent.set(nonce, expires);
    return true;
  }

  has(nonce: string, now: number): boolean {
    const until = this.spent.get(nonce);
    return until !== undefined && until > now;
  }

  clear(): void {
    this.spent.clear();
  }
}
