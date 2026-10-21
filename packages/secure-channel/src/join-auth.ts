// The relay's join key: one shared secret per relay, held by its operator, that lets a machine
// register its account (`role=join`). The operator's admin key, which lists and removes accounts,
// is a key of the same shape used the same way. Neither travels: each request carries an HMAC under it over the same message an agent signs, bound to
// the account, the role and a time, so a captured header is useless for another account, another
// action, or a minute later.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { agentAuthMessage } from './agent-auth';
import { constantTimeEqual } from './constant-time';
import { b64url } from './keys';

type JoinRole = 'join' | 'machines' | 'remove' | 'allow';

export interface JoinClaim {
  // `*` for a request about every account (the list).
  account: string;
  role: JoinRole;
}

export const JOIN_HEADER = 'x-perch-join';
const SCHEME = 'Perch-Join';
const WINDOW_MS = 60_000;

export function generateJoinKey(): string {
  return b64url.encode(randomBytes(32));
}

export function isJoinKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function mac(joinKey: string, claim: JoinClaim, ts: number): string {
  return b64url.encode(hmac(sha256, b64url.decode(joinKey), agentAuthMessage(claim, ts)));
}

export function signJoinAuth(joinKey: string, claim: JoinClaim, nowMs: number): string {
  const ts = Math.floor(nowMs / 1000);
  return `${SCHEME} ${ts}.${mac(joinKey, claim, ts)}`;
}

export function verifyJoinAuth(header: string | undefined | null, joinKey: string, claim: JoinClaim, nowMs: number): boolean {
  const match = /^Perch-Join (\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(header ?? '');
  if (!match || !isJoinKey(joinKey)) return false;
  const ts = Number(match[1]);
  if (Math.abs(nowMs - ts * 1000) > WINDOW_MS) return false;
  return constantTimeEqual(mac(joinKey, claim, ts), match[2]!);
}
