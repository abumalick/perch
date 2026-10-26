// The accounts a relay serves, and the requests that change them. A machine registers itself with
// `role=join`, carrying two proofs: its agent signature (it holds the account's key) and an HMAC
// under the relay's join key (the relay's operator let it in). Neither alone registers anything,
// and neither is something the relay could have observed and replayed for another account. The
// operator lists and removes accounts with a separate admin key: the join key is handed to every
// machine that joins, so it must not also reach the other accounts.
//
// A removed account stays on a deny list that a join cannot lift: whoever removed it may have done
// so because its agent key was stolen, and the thief holds the join key too (every machine does).
// Only the admin key lifts it (`role=allow`); the machine then joins as before.
//
// Hosts keep the registry behind a port (a file on Node, a Durable Object's SQLite on
// Cloudflare).
import { JOIN_HEADER, accountId, isEd25519PublicKey, verifyAgentAuth, verifyJoinAuth } from '@perch/secure-channel';

export interface AccountEntry {
  account: string;
  // The agent's Ed25519 public key (base64url).
  key: string;
  addedAt: string;
}

export interface RemovedEntry extends AccountEntry {
  removedAt: string;
}

export interface AccountRegistry {
  lookup(account: string): Promise<string | undefined>;
  // 'removed' for an account on the deny list, which is not added.
  add(entry: AccountEntry): Promise<'added' | 'exists' | 'removed'>;
  // Takes the account off and puts it on the deny list; false when it was not registered.
  remove(account: string, removedAt: string): Promise<boolean>;
  // Lifts the account's removal; false when it was not removed.
  allow(account: string): Promise<boolean>;
  list(): Promise<AccountEntry[]>;
  removedAccounts(): Promise<RemovedEntry[]>;
}

export interface RegistryState {
  accounts: Record<string, { key: string; addedAt: string }>;
  removed?: Record<string, { key: string; addedAt: string; removedAt: string }>;
}

export const EMPTY_REGISTRY: RegistryState = { accounts: {}, removed: {} };

// A registry held in memory; `persist` is called with every state it moves to.
export class MemoryRegistry implements AccountRegistry {
  constructor(
    private state: RegistryState = EMPTY_REGISTRY,
    private readonly persist: (state: RegistryState) => Promise<void> | void = () => undefined,
  ) {}

  async lookup(account: string): Promise<string | undefined> {
    return Object.hasOwn(this.state.accounts, account) ? this.state.accounts[account]!.key : undefined;
  }

  async add(entry: AccountEntry): Promise<'added' | 'exists' | 'removed'> {
    if (Object.hasOwn(this.state.accounts, entry.account)) return 'exists';
    if (Object.hasOwn(this.removed, entry.account)) return 'removed';
    await this.move({ ...this.state, accounts: { ...this.state.accounts, [entry.account]: { key: entry.key, addedAt: entry.addedAt } } });
    return 'added';
  }

  async remove(account: string, removedAt: string): Promise<boolean> {
    if (!Object.hasOwn(this.state.accounts, account)) return false;
    const { [account]: entry, ...accounts } = this.state.accounts;
    await this.move({ accounts, removed: { ...this.removed, [account]: { ...entry!, removedAt } } });
    return true;
  }

  async allow(account: string): Promise<boolean> {
    if (!Object.hasOwn(this.removed, account)) return false;
    const { [account]: _, ...removed } = this.removed;
    await this.move({ ...this.state, removed });
    return true;
  }

  async list(): Promise<AccountEntry[]> {
    return Object.entries(this.state.accounts).map(([account, { key, addedAt }]) => ({ account, key, addedAt }));
  }

  async removedAccounts(): Promise<RemovedEntry[]> {
    return Object.entries(this.removed).map(([account, entry]) => ({ account, ...entry }));
  }

  private get removed(): NonNullable<RegistryState['removed']> {
    return this.state.removed ?? {};
  }

  private async move(next: RegistryState): Promise<void> {
    await this.persist(next);
    this.state = next;
  }
}

export interface JoinLimit {
  max: number;
  windowMs: number;
}

export const DEFAULT_JOIN_LIMIT: JoinLimit = { max: 10, windowMs: 10 * 60_000 };
const MAX_TRACKED = 4096;

// Requests with the join or admin key, counted per client address in fixed windows. Every attempt counts,
// good or bad: guessing the 32-byte key is hopeless anyway, and this bounds the work and the
// registry writes one address can cause.
export class JoinRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: JoinLimit,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.windows.size;
  }

  // The map is kept in the order windows started (a renewed window moves to the end), so once
  // every tracked window is live the oldest goes: that only gives its address a fresh window,
  // where refusing newcomers would lock the owner out under a flood.
  take(address: string): boolean {
    const now = this.now();
    if (this.windows.size >= MAX_TRACKED) {
      for (const [key, window] of this.windows) if (now - window.start >= this.limit.windowMs) this.windows.delete(key);
    }
    const current = this.windows.get(address);
    if (!current || now - current.start >= this.limit.windowMs) {
      this.windows.delete(address);
      while (this.windows.size >= MAX_TRACKED) this.windows.delete(this.windows.keys().next().value!);
      this.windows.set(address, { start: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit.max;
  }
}

export type AdminRequest =
  | { role: 'join'; account: string; key: string; authorization?: string; join?: string }
  | { role: 'machines'; account: '*'; join?: string }
  | { role: 'remove' | 'allow'; account: string; join?: string };

// A request about the registry, or null for anything else (the relay roles, parsed as before).
export function parseAdminRequest(url: string, method: string, header: (name: string) => string | null | undefined): AdminRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://relay');
  } catch {
    return null;
  }
  const role = parsed.searchParams.get('role');
  const account = parsed.pathname.slice(1);
  const join = header(JOIN_HEADER) ?? undefined;
  if (role === 'machines') return method === 'GET' && account === '' ? { role, account: '*', join } : null;
  if ((role !== 'join' && role !== 'remove' && role !== 'allow') || method !== 'POST' || !/^[\w-]{1,64}$/.test(account)) return null;
  if (role === 'remove' || role === 'allow') return { role, account, join };
  const key = parsed.searchParams.get('key');
  if (!key) return null;
  return { role, account, key, authorization: header('authorization') ?? undefined, join };
}

export interface AdminDeps {
  registry: AccountRegistry;
  // Unset, joining is off: a join answers 501.
  joinKey?: string;
  // Lists and removes accounts. Unset, those answer 501.
  adminKey?: string;
  limiter: JoinRateLimiter;
  now: () => number;
  // Closes what a removed account still holds on the relay: its control socket and its pairs.
  evict: (account: string) => Promise<void> | void;
  // An account joined: the relay serves it again, whatever eviction left behind.
  reinstate?: (account: string) => Promise<void> | void;
}

export interface AdminResponse {
  status: number;
  body: string;
}

const text = (status: number, body: string): AdminResponse => ({ status, body });

export async function handleAdminRequest(request: AdminRequest, address: string, deps: AdminDeps): Promise<AdminResponse> {
  if (!deps.limiter.take(address)) return text(429, 'too many requests');
  const key = request.role === 'join' ? deps.joinKey : deps.adminKey;
  if (!key) return text(501, request.role === 'join' ? 'joining is not enabled on this relay' : 'no admin key on this relay');
  const now = deps.now();
  if (!verifyJoinAuth(request.join, key, { account: request.account, role: request.role }, now)) {
    return text(401, request.role === 'join' ? 'join key refused' : 'admin key refused');
  }
  switch (request.role) {
    case 'join':
      return join(request, deps, now);
    case 'machines':
      return text(200, JSON.stringify([...(await deps.registry.list()), ...(await deps.registry.removedAccounts())]));
    case 'remove': {
      const removed = await deps.registry.remove(request.account, new Date(now).toISOString());
      // The registry changes before the eviction. Should that fail, the account is denied with its
      // sockets still open and no longer registered, so a removal repeated for one on the deny
      // list evicts again (eviction is idempotent) instead of answering 404.
      if (!removed && !(await deps.registry.removedAccounts()).some((entry) => entry.account === request.account)) {
        return text(404, 'unknown account');
      }
      await deps.evict(request.account);
      return text(200, 'removed');
    }
    case 'allow':
      return (await deps.registry.allow(request.account)) ? text(200, 'allowed') : text(404, 'account not removed');
  }
}

async function join(request: Extract<AdminRequest, { role: 'join' }>, deps: AdminDeps, now: number): Promise<AdminResponse> {
  let derived: string;
  try {
    derived = accountId(request.key);
  } catch {
    return text(400, 'malformed agent key');
  }
  if (!isEd25519PublicKey(request.key)) return text(400, 'malformed agent key');
  if (derived !== request.account) return text(400, 'account does not match its key');
  if (!(await verifyAgentAuth(request.authorization, request.key, { account: request.account, role: 'join' }, now))) {
    return text(401, 'agent signature refused');
  }
  const added = await deps.registry.add({ account: request.account, key: request.key, addedAt: new Date(now).toISOString() });
  if (added === 'removed') return text(403, 'account removed by the relay operator');
  if (added === 'added') await deps.reinstate?.(request.account);
  return added === 'added' ? text(201, 'joined') : text(200, 'already joined');
}
