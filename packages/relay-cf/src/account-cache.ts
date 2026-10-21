import { authorize } from '@perch/relay/authorize';
import type { RelayRequest } from '@perch/relay';

// Which accounts the registry holds, remembered per isolate so a phone's requests, and a
// stranger's guesses, do not all reach the single RegistryRoom.
//
// A hit is kept for every role. A removed account still cannot come back through one: the control
// socket is confirmed with the registry once its signature checks out (`authorizeCached`), and the
// account's own RelayRoom refuses everything once evicted, whatever a stale hit let through. A miss
// is kept briefly: a repeated guess then costs the registry one request per isolate per window. A
// distinct guess is a new miss, so it still reaches the registry; that is the remaining limit
// (see the runbook's "Challenges, enrolment dials and misses").
//
// Hits and misses are kept apart, so a flood of guesses only ever evicts misses: hits go least
// recently used first, misses oldest first. A machine that joins through this isolate is found at
// once (`joined`); through another, within the miss window.
export interface AccountCacheOptions {
  now: () => number;
  hitMs: number;
  missMs: number;
  // Per kind: hits and misses each hold at most this many.
  maxEntries: number;
}

type Ask = (account: string) => Promise<string | undefined>;

export class AccountCache {
  private readonly hits = new Map<string, { key: string; until: number }>();
  private readonly misses = new Map<string, number>();

  constructor(private readonly options: AccountCacheOptions) {}

  get size(): number {
    return this.hits.size + this.misses.size;
  }

  async lookup(account: string, ask: Ask): Promise<string | undefined> {
    const now = this.options.now();
    const hit = this.hits.get(account);
    if (hit && hit.until > now) {
      this.hits.delete(account);
      this.hits.set(account, hit);
      return hit.key;
    }
    const missUntil = this.misses.get(account);
    if (missUntil !== undefined && missUntil > now) return undefined;
    const key = await ask(account);
    this.hits.delete(account);
    this.misses.delete(account);
    if (key) remember(this.hits, account, { key, until: now + this.options.hitMs }, this.options.maxEntries);
    else remember(this.misses, account, now + this.options.missMs, this.options.maxEntries);
    return key;
  }

  joined(account: string): void {
    this.misses.delete(account);
  }

  removed(account: string): void {
    this.hits.delete(account);
  }
}

function remember<V>(map: Map<string, V>, account: string, value: V, max: number): void {
  while (map.size >= max) map.delete(map.keys().next().value!);
  map.set(account, value);
}

// `authorize` over the cache. A control socket answered from a hit has its signature checked
// against the cached key, and only then is the account confirmed with the registry: a forged
// one never reaches it, and a removed account is refused (and forgotten) at once.
export async function authorizeCached(request: RelayRequest, cache: AccountCache, ask: Ask, nowMs: number): Promise<404 | 401 | null> {
  let asked = false;
  const fresh: Ask = (account) => {
    asked = true;
    return ask(account);
  };
  const refused = await authorize(request, (account) => cache.lookup(account, fresh), nowMs);
  if (refused || request.role !== 'agent' || asked) return refused;
  if (await ask(request.account)) return null;
  cache.removed(request.account);
  return 404;
}
