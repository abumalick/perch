import { verifyAgentAuth } from '@perch/secure-channel';
import type { RelayRequest } from './relay.ts';

// account id → the agent's Ed25519 public key (base64url).
export type AgentDirectory = Record<string, string>;

export function validateAgents(parsed: unknown): AgentDirectory {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('agents must be a JSON object');
  }
  const agents: AgentDirectory = {};
  for (const [account, key] of Object.entries(parsed)) {
    if (!/^[\w-]{1,64}$/.test(account) || typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
      throw new Error(`agents: bad entry for ${JSON.stringify(account)}`);
    }
    agents[account] = key;
  }
  return agents;
}

// The agent's Ed25519 public key registered for an account, or undefined for an account the
// relay does not serve.
export type AccountLookup = (account: string) => Promise<string | undefined>;

// The HTTP status to refuse the request with, or null to let it through. An unknown account is
// refused before anything is allocated for it; the agent roles must carry a valid signature.
export async function authorize(request: RelayRequest, lookup: AccountLookup, nowMs: number): Promise<404 | 401 | null> {
  const key = await lookup(request.account);
  if (!key) return 404;
  // Clients are gated inside the account's relay, against the policy its agent published.
  if (request.role === 'client' || request.role === 'challenge') return null;
  const claim = { account: request.account, role: request.role, dialId: request.role === 'dial' || request.role === 'spare' ? request.id : undefined };
  return (await verifyAgentAuth(request.authorization, key, claim, nowMs)) ? null : 401;
}
