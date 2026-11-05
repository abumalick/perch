import { b64url, type AgentKeys } from '@tarfa/secure-channel';
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
  server: Pick<WsServer, 'refuseRevokedDevices'>;
  store: DeviceStorePort;
  pairings: PairingStorePort;
  log: (message: string) => void;
  rosterPollMs: number;
}

// The device gate every phone session goes through: one roster, one push budget, one refusal log,
// and one monitor that closes revoked sessions.
export interface AgentDeviceGate {
  staticPrivate: Uint8Array;
  devices: RosterDevices;
  options(extra: { onAuthenticated?: () => void }): NoiseClientConnectionOptions;
  // The roster as last read (null before the first read), which answers an enrolled key without
  // a read of its own (limitedDevices).
  roster(): DeviceRoster | null;
  // Checks the roster for edits made by another process (`tarfa devices`) now, rather than on
  // the next tick.
  pollRoster(): Promise<void>;
  stop(): void;
}

export function startDeviceGate(deps: DeviceGateDeps): AgentDeviceGate {
  const { keys, server, store, log } = deps;
  let last: DeviceRoster | null = null;
  // After this agent's own write, so a phone it just enrolled is known at its next connect
  // rather than the next poll.
  const wrote = () => {
    store.read().then((roster) => (last = roster), () => undefined);
  };
  const devices = new RosterDevices({
    store,
    pairings: deps.pairings,
    now: () => new Date(),
    onChange: wrote,
  });
  const pushBudget = new PushBudget(() => Date.now());
  const refusalLog = new LimitedLog(log, () => Date.now());
  // `tarfa devices` edits the roster from another process: close the sessions of devices it
  // revoked.
  const monitor = new RosterMonitor(
    store,
    (roster) => {
      log(`device roster changed (${roster.devices.length} enrolled, ${roster.revoked.length} revoked)`);
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
    staticPrivate: b64url.decode(keys.x25519.privateKey),
    devices,
    options: (extra) => ({ devices, log, refusalLog, pushBudget, ...extra }),
    roster: () => last,
    pollRoster: () => monitor.poll(),
    stop: () => clearInterval(poll),
  };
}
