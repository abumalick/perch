import { accountId, b64url, enrolKey, type AgentKeys } from '@perch/secure-channel';
import { PushBudget } from '../application/push-budget';
import { LimitedLog } from '../application/limited-log';
import { RosterDevices, RosterMonitor } from '../application/device-gate';
import { standingOf, type DeviceRoster } from '../application/device-roster';
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
  // The roster as last read (null before the first read), which answers an enrolled key without
  // a read of its own (limitedDevices).
  roster(): DeviceRoster | null;
  // Checks the roster for edits made by another process (`perch devices`) now, rather than on
  // the next tick.
  pollRoster(): Promise<void>;
  stop(): void;
}

export function startDeviceGate(deps: DeviceGateDeps): AgentDeviceGate {
  const { keys, server, store, log } = deps;
  const account = accountId(keys.ed25519.publicKey);
  const listeners: Array<() => void> = [];
  let last: DeviceRoster | null = null;
  const changed = () => listeners.forEach((l) => l());
  // After this agent's own write, so a phone it just enrolled is known at its next connect
  // rather than the next poll.
  const wrote = () => {
    changed();
    store.read().then((roster) => (last = roster), () => undefined);
  };
  const devices = new RosterDevices({
    store,
    pairings: deps.pairings,
    now: () => new Date(),
    account,
    enrolKey: enrolKey(deps.token, account),
    onChange: wrote,
  });
  const pushBudget = new PushBudget(() => Date.now());
  const refusalLog = new LimitedLog(log, () => Date.now());
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
      last = roster;
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
    roster: () => last,
    pollRoster: () => monitor.poll(),
    stop: () => clearInterval(poll),
  };
}
