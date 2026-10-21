// `perch connect` and `perch pair`: register this machine with a relay, point the agent at it,
// and hand a phone what it needs to pair, in one step each.
import { accountId, isPairingPath, pairingLink, signAgentAuth, signJoinAuth, type AgentKeys } from '@perch/secure-channel';
import type { PairingStorePort } from '../ports/pairing-store-port';
import type { RelayJoinPort } from '../ports/relay-join-port';
import type { AgentEnvPort } from '../ports/agent-env-port';
import type { AgentServicePort } from '../ports/agent-service-port';
import { addRelayUrl, parseEnvFile, setEnvValue } from './agent-env';
import { addPairing } from './pairing';
import { isCleartextRemote, withoutTrailingSlash } from './relay-url';

export interface ConnectDeps {
  keys: AgentKeys;
  machineId: string;
  // PERCH_DEFAULT_PATH: the root a newly paired phone resolves relative New-workspace paths against.
  defaultPath?: string;
  relay: RelayJoinPort;
  env: AgentEnvPort;
  service: AgentServicePort;
  pairings: PairingStorePort;
  newSecret: () => string;
  now: () => Date;
}

export interface ConnectInput {
  // The relay as phones reach it.
  relayUrl: string;
  // The relay as this agent reaches it, when that differs (the relay's own machine).
  agentUrl?: string;
  joinKey: string;
  pwaOrigin?: string;
}

const JOIN_REFUSALS: Record<number, string> = {
  401: 'the relay refused the join key: check the command its operator gave you',
  404: 'this relay does not support joining yet: its operator needs to update it',
  429: 'too many join attempts from this address: wait ten minutes and try again',
  501: 'this relay has no join key configured: its operator runs `perch-relay join-command`',
};

function relayBase(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error(`relay URL must start with wss:// or ws://: ${url}`);
  if (isCleartextRemote(url)) throw new Error(`a relay off this machine must be wss://, or its upgrades travel in the clear: ${url}`);
  return withoutTrailingSlash(url);
}

// The phone drops a path it cannot use, so one is refused here, where its owner can fix it.
function checkDefaultPath(path: string | undefined): void {
  if (path !== undefined && !isPairingPath(path)) {
    throw new Error(`PERCH_DEFAULT_PATH must be an absolute path of at most 128 characters (got ${path})`);
  }
}

export async function connectMachine(deps: ConnectDeps, input: ConnectInput): Promise<{ lines: string[]; link?: string }> {
  checkDefaultPath(deps.defaultPath);
  const relayUrl = relayBase(input.relayUrl);
  const agentUrl = relayBase(input.agentUrl ?? input.relayUrl);
  const account = accountId(deps.keys.ed25519.publicKey);
  const now = deps.now().getTime();
  const claim = { account, role: 'join' as const };
  const joined = await deps.relay.join(relayUrl, {
    account,
    key: deps.keys.ed25519.publicKey,
    authorization: signAgentAuth(deps.keys.ed25519.privateKey, claim, now),
    join: signJoinAuth(input.joinKey, claim, now),
  });
  if (joined.status !== 200 && joined.status !== 201) {
    throw new Error(JOIN_REFUSALS[joined.status] ?? `the relay refused to register this machine (${joined.status}: ${joined.body.slice(0, 120)})`);
  }
  const lines = [`${joined.status === 201 ? 'registered' : 'already registered'} with ${relayUrl} as account ${account}`];

  const before = await deps.env.read();
  let text = addRelayUrl(before, agentUrl).text;
  if (input.pwaOrigin && parseEnvFile(text).PERCH_PWA_ORIGIN !== input.pwaOrigin) text = setEnvValue(text, 'PERCH_PWA_ORIGIN', input.pwaOrigin);
  if (text === before) {
    lines.push(`${deps.env.path} already holds this relay; the agent was not restarted`);
  } else {
    const backup = await deps.env.write(text);
    lines.push(`updated ${deps.env.path} (previous version kept at ${backup})`);
    try {
      lines.push(`restarted the agent (${await deps.service.restart()})`);
    } catch (err) {
      lines.push(`could not restart the agent (${err instanceof Error ? err.message : String(err)}): restart the agent yourself`);
    }
  }

  const pwaOrigin = input.pwaOrigin ?? parseEnvFile(text).PERCH_PWA_ORIGIN;
  if (!pwaOrigin) {
    lines.push('', 'No PWA origin known, so no pairing link yet. Run `perch pair --pwa <where your phone opens Perch>`.');
    return { lines };
  }
  return { lines, link: await mintPairingLink(deps, { phoneUrl: relayUrl, pwaOrigin }) };
}

const GENERIC_MACHINE_IDS = new Set(['', 'local', 'localhost']);

// The name a phone shows for this machine: its configured id, unless that id is a placeholder
// that would name every machine alike, then the host name without its domain.
export function pairingName(machineId: string, hostname: string): string {
  return GENERIC_MACHINE_IDS.has(machineId) ? hostname.split('.')[0]! : machineId;
}

export async function mintPairingLink(
  deps: Pick<ConnectDeps, 'keys' | 'machineId' | 'defaultPath' | 'pairings' | 'newSecret' | 'now'>,
  input: { phoneUrl: string; pwaOrigin: string },
): Promise<string> {
  checkDefaultPath(deps.defaultPath);
  const secret = deps.newSecret();
  await deps.pairings.update((list) => addPairing(list, secret, deps.now()));
  const account = accountId(deps.keys.ed25519.publicKey);
  return pairingLink(input.pwaOrigin, {
    url: `${relayBase(input.phoneUrl)}/${account}`,
    agentKey: deps.keys.x25519.publicKey,
    secret,
    name: deps.machineId,
    ...(deps.defaultPath !== undefined ? { defaultPath: deps.defaultPath } : {}),
  });
}
