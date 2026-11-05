import { constantTimeEqual } from '@perch/secure-channel';

// A phone pairing secret (`perch pair`): it stands in for the token when a new
// phone enrols, so it is short-lived and good for one device only. A dead one (spent or expired)
// is kept for PAIRING_RETAIN_MS, so a phone that presents it is told which it is.
export interface Pairing {
  secret: string;
  expiresAt: string;
  usedAt?: string;
  // The device (X25519 key) that spent it.
  usedBy?: string;
}

export const PAIRING_TTL_MS = 10 * 60_000;
export const PAIRING_RETAIN_MS = 24 * 60 * 60_000;

type PairingState = 'live' | 'used' | 'expired';

const retained = (list: Pairing[], now: Date) => list.filter((p) => Date.parse(p.expiresAt) + PAIRING_RETAIN_MS > now.getTime());

function stateOf(p: Pairing, now: Date): PairingState {
  if (p.usedAt) return 'used';
  return now.getTime() < Date.parse(p.expiresAt) ? 'live' : 'expired';
}

export function addPairing(list: Pairing[], secret: string, now: Date, ttlMs = PAIRING_TTL_MS): Pairing[] {
  return [...retained(list, now), { secret, expiresAt: new Date(now.getTime() + ttlMs).toISOString() }];
}

// Spends a secret for `device`, which it is then bound to: the same device presenting it again
// (`mine`) is not a second use, any other one is refused. A spent secret's expiry is moved to the
// moment it was spent: an agent that does not know `usedAt` then reads it as expired, never live.
export function redeemPairing(
  list: Pairing[],
  secret: string,
  now: Date,
  device: string,
): { list: Pairing[]; outcome: 'redeemed' | 'mine' | 'used' | 'expired' | 'unknown' } {
  const kept = retained(list, now);
  const match = secret ? kept.find((p) => constantTimeEqual(p.secret, secret)) : undefined;
  if (!match) return { list: kept, outcome: 'unknown' };
  if (match.usedAt && match.usedBy === device) return { list: kept, outcome: 'mine' };
  const state = stateOf(match, now);
  if (state !== 'live') return { list: kept, outcome: state };
  const at = now.toISOString();
  const spent: Pairing = { secret: match.secret, expiresAt: at, usedAt: at, usedBy: device };
  return { list: kept.map((p) => (p === match ? spent : p)), outcome: 'redeemed' };
}
