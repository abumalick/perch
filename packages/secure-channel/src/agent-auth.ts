// How the agent proves to the relay that it is the agent. It signs each upgrade (the control
// socket and every dial-back) with its Ed25519 key, and the relay checks the signature against
// the public key registered for the account. The relay stores no secret.
import { ed25519 } from '@noble/curves/ed25519.js';
import { b64url } from './keys';

// `join` registers the account with the relay (with the relay's join key beside it). A `spare`
// is a dial-back opened ahead of any client, under an id the agent picks.
type AgentRole = 'agent' | 'dial' | 'spare' | 'join';

interface AgentClaim {
  account: string;
  role: AgentRole;
  dialId?: string;
}

const SCHEME = 'Perch-Agent';
const WINDOW_MS = 60_000;

export function agentAuthMessage(claim: { account: string; role: string; dialId?: string }, ts: number): Uint8Array {
  return new TextEncoder().encode(['perch-relay-v1', claim.account, claim.role, claim.dialId ?? '-', String(ts)].join('\n'));
}

export function signAgentAuth(ed25519PrivateKey: string, claim: AgentClaim, nowMs: number): string {
  const ts = Math.floor(nowMs / 1000);
  const signature = ed25519.sign(agentAuthMessage(claim, ts), b64url.decode(ed25519PrivateKey));
  return `${SCHEME} ${ts}.${b64url.encode(signature)}`;
}

// Async because it prefers the runtime's native Ed25519 (WebCrypto): on a Worker the pure-JS
// verifier alone costs a large share of the free plan's 10 ms CPU budget per request. Runtimes
// without it (or a key it refuses) fall back to noble, with ZIP-215 off so it gives the same
// answers: under ZIP-215 a forged signature verifies under a small-order public key.
export async function verifyAgentAuth(
  header: string | undefined | null,
  ed25519PublicKey: string,
  claim: AgentClaim,
  nowMs: number,
  subtle: SubtleCrypto | undefined = typeof crypto === 'undefined' ? undefined : crypto.subtle,
): Promise<boolean> {
  const match = /^Perch-Agent (\d{1,12})\.([A-Za-z0-9_-]{86})$/.exec(header ?? '');
  if (!match) return false;
  const ts = Number(match[1]);
  if (Math.abs(nowMs - ts * 1000) > WINDOW_MS) return false;
  let signature: Uint8Array<ArrayBuffer>;
  let publicKey: Uint8Array<ArrayBuffer>;
  try {
    signature = b64url.decode(match[2]!);
    publicKey = b64url.decode(ed25519PublicKey);
  } catch {
    return false;
  }
  return verifyEd25519(signature, new Uint8Array(agentAuthMessage(claim, ts)), publicKey, subtle);
}

export async function verifyEd25519(
  signature: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>,
  publicKey: Uint8Array<ArrayBuffer>,
  subtle: SubtleCrypto | undefined,
): Promise<boolean> {
  if (subtle) {
    try {
      const key = await subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
      return await subtle.verify({ name: 'Ed25519' }, key, signature, message);
    } catch {
      // No Ed25519 in this runtime's WebCrypto, or a key it would not import.
    }
  }
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

// A key that can stand for an agent or a device: 32 bytes of base64url naming a point on the
// curve outside its small-order subgroup. Checked where a key is taken in (a join, a device's
// hello, a published policy), not on every signature: the Worker's CPU budget is per request.
export function isEd25519PublicKey(key: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return false;
  try {
    return !ed25519.Point.fromBytes(b64url.decode(key)).isSmallOrder();
  } catch {
    return false;
  }
}
