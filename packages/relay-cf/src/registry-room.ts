import { DurableObject } from 'cloudflare:workers';
import {
  JoinRateLimiter,
  handleAdminRequest,
  type AccountEntry,
  type AccountRegistry,
  type AdminRequest,
  type AdminResponse,
  type RemovedEntry,
} from '@perch/relay/registry';
import { parseJoinLimit } from '@perch/relay/config';
import type { Env } from './env';

// The accounts this relay serves, in one Durable Object's SQLite, so a machine that joins is
// served at once: no secret to edit and no redeploy, which would also drop every socket.
export class RegistryRoom extends DurableObject<Env> implements AccountRegistry {
  // One instance serves every join, so its memory is where the per-address count lives. An
  // eviction resets it, which only ever gives an address a fresh window.
  private readonly limiter: JoinRateLimiter;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // An instance may also hold `seeded` and `meta` tables, unused: dropping them would take a
    // migration for no gain.
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS accounts (account TEXT PRIMARY KEY, key TEXT NOT NULL, added_at TEXT NOT NULL)');
    // The deny list of removed accounts, which a join cannot lift. A table, not a migration: a
    // Durable Object's own SQLite schema is its own business.
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS removed (account TEXT PRIMARY KEY, key TEXT NOT NULL, added_at TEXT NOT NULL, removed_at TEXT NOT NULL)',
    );
    this.limiter = new JoinRateLimiter(parseJoinLimit({ joinMax: env.RELAY_JOIN_MAX, joinWindowMs: env.RELAY_JOIN_WINDOW_MS }));
  }

  async lookup(account: string): Promise<string | undefined> {
    const row = this.ctx.storage.sql.exec<{ key: string }>('SELECT key FROM accounts WHERE account = ?', account).toArray()[0];
    return row?.key;
  }

  async add(entry: AccountEntry): Promise<'added' | 'exists' | 'removed'> {
    if (this.ctx.storage.sql.exec('SELECT 1 FROM removed WHERE account = ?', entry.account).toArray().length > 0) return 'removed';
    const cursor = this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO accounts (account, key, added_at) VALUES (?, ?, ?)',
      entry.account,
      entry.key,
      entry.addedAt,
    );
    return cursor.rowsWritten > 0 ? 'added' : 'exists';
  }

  // Synchronous SQL within one method, so the move from one table to the other is atomic.
  async remove(account: string, removedAt: string): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    sql.exec(
      'INSERT OR REPLACE INTO removed (account, key, added_at, removed_at) SELECT account, key, added_at, ? FROM accounts WHERE account = ?',
      removedAt,
      account,
    );
    return sql.exec('DELETE FROM accounts WHERE account = ?', account).rowsWritten > 0;
  }

  async allow(account: string): Promise<boolean> {
    return this.ctx.storage.sql.exec('DELETE FROM removed WHERE account = ?', account).rowsWritten > 0;
  }

  async removedAccounts(): Promise<RemovedEntry[]> {
    return this.ctx.storage.sql
      .exec<{ account: string; key: string; added_at: string; removed_at: string }>(
        'SELECT account, key, added_at, removed_at FROM removed ORDER BY removed_at',
      )
      .toArray()
      .map((row) => ({ account: row.account, key: row.key, addedAt: row.added_at, removedAt: row.removed_at }));
  }

  async list(): Promise<AccountEntry[]> {
    return this.ctx.storage.sql
      .exec<{ account: string; key: string; added_at: string }>('SELECT account, key, added_at FROM accounts ORDER BY added_at')
      .toArray()
      .map((row) => ({ account: row.account, key: row.key, addedAt: row.added_at }));
  }

  async admin(request: AdminRequest, address: string): Promise<AdminResponse> {
    return handleAdminRequest(request, address, {
      registry: this,
      joinKey: this.env.JOIN_KEY || undefined,
      adminKey: this.env.ADMIN_KEY || undefined,
      limiter: this.limiter,
      now: Date.now,
      evict: (account) => this.env.RELAY.getByName(account).evict(),
      reinstate: (account) => this.env.RELAY.getByName(account).reinstate(),
    });
  }
}
