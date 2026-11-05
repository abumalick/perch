// `perch pair`: hand a phone what it needs to pair with this machine.
import { isPairingPath, pairingLink, type AgentKeys } from '@perch/secure-channel';
import type { PairingStorePort } from '../ports/pairing-store-port';
import { addPairing } from './pairing';

export interface PairingDeps {
  keys: AgentKeys;
  machineId: string;
  // PERCH_DEFAULT_PATH: the root a newly paired phone resolves relative New-workspace paths against.
  defaultPath?: string;
  pairings: PairingStorePort;
  newSecret: () => string;
  now: () => Date;
}

const GENERIC_MACHINE_IDS = new Set(['', 'local', 'localhost']);

// The name a phone shows for this machine: its configured id, unless that id is a placeholder
// that would name every machine alike, then the host name without its domain.
export function pairingName(machineId: string, hostname: string): string {
  return GENERIC_MACHINE_IDS.has(machineId) ? hostname.split('.')[0]! : machineId;
}

// `phoneUrls` are the addresses the phone tries, in order, each as the phone dials it.
export async function mintPairingLink(deps: PairingDeps, input: { phoneUrls: string[]; pwaOrigin: string }): Promise<string> {
  // The phone drops a path it cannot use, so one is refused here, where its owner can fix it.
  if (deps.defaultPath !== undefined && !isPairingPath(deps.defaultPath)) {
    throw new Error(`PERCH_DEFAULT_PATH must be an absolute path of at most 128 characters (got ${deps.defaultPath})`);
  }
  const secret = deps.newSecret();
  await deps.pairings.update((list) => addPairing(list, secret, deps.now()));
  return pairingLink(input.pwaOrigin, {
    urls: input.phoneUrls,
    agentKey: deps.keys.x25519.publicKey,
    secret,
    name: deps.machineId,
    ...(deps.defaultPath !== undefined ? { defaultPath: deps.defaultPath } : {}),
  });
}
