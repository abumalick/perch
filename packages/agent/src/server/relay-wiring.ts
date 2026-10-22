import { accountId, b64url, enrolKey, signAgentAuth, startTimer, type AgentKeys } from '@perch/secure-channel';
import { RelayLink } from '../application/relay-link';
import { PushBudget } from '../application/push-budget';
import { LimitedLog } from '../application/limited-log';
import { RosterDevices, RosterMonitor } from '../application/device-gate';
import { relayPolicy, standingOf } from '../application/device-roster';
import type { DeviceStorePort } from '../ports/device-store-port';
import type { PairingStorePort } from '../ports/pairing-store-port';
import type { FrameSocket } from '../ports/frame-socket';
import type { RelayTransport } from '../ports/relay-port';
import type { WsServer } from './ws-server';

export interface RelayWiringDeps {
  config: { relayUrls: string[]; token: string };
  keys: AgentKeys;
  server: Pick<WsServer, 'acceptRelaySocket' | 'refuseRevokedDevices'>;
  store: DeviceStorePort;
  pairings: PairingStorePort;
  transport: RelayTransport<FrameSocket>;
  log: (message: string) => void;
  rosterPollMs: number;
  enrolmentChecksPerMinute?: number;
}

export interface RelayWiring {
  account: string;
  // Checks the roster for edits made by another process (`perch devices`) now, rather than on
  // the next tick.
  pollRoster(): Promise<void>;
  stop(): void;
}

// The agent's relay side: one link per relay URL, all serving one account, the device gate over
// the roster, and the roster monitor that republishes the policy and closes revoked sessions.
export function startRelayLinks(deps: RelayWiringDeps): RelayWiring {
  const { config, keys, server, store, log } = deps;
  const account = accountId(keys.ed25519.publicKey);
  const staticPrivate = b64url.decode(keys.x25519.privateKey);
  const links: Array<RelayLink<FrameSocket>> = [];
  const publishAll = () => links.forEach((link) => void link.publish());
  const devices = new RosterDevices({
    store,
    pairings: deps.pairings,
    now: () => new Date(),
    account,
    enrolKey: enrolKey(config.token, account),
    onChange: publishAll,
  });
  const pushBudget = new PushBudget(() => Date.now());
  const refusalLog = new LimitedLog(log, () => Date.now());
  // One key, so one account on every relay: the phone keeps an entry per relay and toggles.
  for (const url of config.relayUrls) {
    const link = new RelayLink({
      url,
      account,
      authHeaders: (role, dialId) => ({
        authorization: signAgentAuth(keys.ed25519.privateKey, { account, role, dialId }, Date.now()),
      }),
      transport: deps.transport,
      // The dial's slot is held until the session authenticates or the socket closes.
      onSocket: (socket, release) => {
        socket.onClose(release);
        server.acceptRelaySocket(socket, staticPrivate, { devices, log, refusalLog, onAuthenticated: release, pushBudget });
      },
      policy: async () => relayPolicy(await store.read()),
      admitEnrolment: (enrol) => devices.admitsEnrolment(enrol),
      startTimer,
      log,
      enrolmentChecksPerMinute: deps.enrolmentChecksPerMinute,
    });
    links.push(link);
    link.start();
  }
  // `perch devices` edits the roster from another process: republish, and close the sessions
  // of devices it revoked.
  const monitor = new RosterMonitor(store, (roster) => {
    log(`relay: device roster changed (${roster.devices.length} enrolled, ${roster.revoked.length} revoked)`);
    publishAll();
    server.refuseRevokedDevices((key) => standingOf(roster, key) === 'revoked');
  });
  void monitor.poll();
  const poll = setInterval(() => void monitor.poll(), deps.rosterPollMs);
  poll.unref();
  return {
    account,
    pollRoster: () => monitor.poll(),
    stop: () => {
      clearInterval(poll);
      links.forEach((link) => link.stop());
    },
  };
}
