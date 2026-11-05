import { accountId, b64url, enrolKey, type AgentKeys } from '@perch/secure-channel';
import { PushBudget } from '../application/push-budget';
import { LimitedLog } from '../application/limited-log';
import { RosterDevices, RosterMonitor } from '../application/device-gate';
import { standingOf } from '../application/device-roster';
import type { DeviceStorePort } from '../ports/device-store-port';
import type { PairingStorePort } from '../ports/pairing-store-port';
import type { NoiseClientConnectionOptions } from './noise-client-connection';
import type { WsServer } from './ws-server';

export interface DeviceGateDeps {
  keys: AgentKeys;
  token: string;
  server: Pick<WsServer, 'refuseRevokedDevices'>;
  store: DeviceStorePort;
  pairings: PairingStorePort;
  log: (message: string) => void;
  rosterPollMs: number;
}

// The device gate every phone session goes through, whether a relay dialed it or the phone
// connected directly: one roster, one push budget, one refusal log, and one monitor that closes
// revoked sessions of both kinds.
export interface AgentDeviceGate {
  account: string;
  staticPrivate: Uint8Array;
  devices: RosterDevices;
  options(extra: { onAuthenticated?: () => void }): NoiseClientConnectionOptions;
  // Called when the roster changed, by this agent or behind its back.
  onRosterChange(listener: () => void): void;
  // The X25519 keys enrolled and not revoked, as of the last roster read.
  enrolledKeys(): ReadonlySet<string>;
  // Checks the roster for edits made by another process (`perch devices`) now, rather than on
  // the next tick.
  pollRoster(): Promise<void>;
  stop(): void;
}

export function startDeviceGate(deps: DeviceGateDeps): AgentDeviceGate {
  const { keys, server, store, log } = deps;
  const account = accountId(keys.ed25519.publicKey);
  const listeners: Array<() => void> = [];
  const changed = () => listeners.forEach((l) => l());
  const devices = new RosterDevices({
    store,
    pairings: deps.pairings,
    now: () => new Date(),
    account,
    enrolKey: enrolKey(deps.token, account),
    onChange: changed,
  });
  const pushBudget = new PushBudget(() => Date.now());
  const refusalLog = new LimitedLog(log, () => Date.now());
  let enrolled: ReadonlySet<string> = new Set();
  // `perch devices` edits the roster from another process: close the sessions of devices it
  // revoked, and tell the relays.
  const monitor = new RosterMonitor(
    store,
    (roster) => {
      log(`device roster changed (${roster.devices.length} enrolled, ${roster.revoked.length} revoked)`);
      changed();
      server.refuseRevokedDevices((key) => standingOf(roster, key) === 'revoked');
    },
    (roster) => {
      enrolled = new Set(roster.devices.map((d) => d.x25519).filter((key) => standingOf(roster, key) === 'enrolled'));
    },
  );
  void monitor.poll();
  const poll = setInterval(() => void monitor.poll(), deps.rosterPollMs);
  poll.unref();
  return {
    account,
    staticPrivate: b64url.decode(keys.x25519.privateKey),
    devices,
    options: (extra) => ({ devices, log, refusalLog, pushBudget, ...extra }),
    onRosterChange: (listener) => listeners.push(listener),
    enrolledKeys: () => enrolled,
    pollRoster: () => monitor.poll(),
    stop: () => clearInterval(poll),
  };
}
