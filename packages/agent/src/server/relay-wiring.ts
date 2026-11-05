import { signAgentAuth, startTimer } from '@perch/secure-channel';
import { RelayLink } from '../application/relay-link';
import { relayPolicy } from '../application/device-roster';
import type { DeviceStorePort } from '../ports/device-store-port';
import type { FrameSocket } from '../ports/frame-socket';
import type { RelayTransport } from '../ports/relay-port';
import type { AgentDeviceGate } from './device-gate-wiring';
import type { WsServer } from './ws-server';

export interface RelayWiringDeps {
  config: { relayUrls: string[] };
  keys: { ed25519: { privateKey: string } };
  gate: AgentDeviceGate;
  server: Pick<WsServer, 'acceptPhoneSocket'>;
  store: DeviceStorePort;
  transport: RelayTransport<FrameSocket>;
  log: (message: string) => void;
  enrolmentChecksPerMinute?: number;
}

export interface RelayWiring {
  account: string;
  stop(): void;
}

// The agent's relay side: one link per relay URL, all serving one account through the shared
// device gate, republishing the policy whenever the roster changes.
export function startRelayLinks(deps: RelayWiringDeps): RelayWiring {
  const { config, keys, gate, server, store, log } = deps;
  const account = gate.account;
  const links: Array<RelayLink<FrameSocket>> = [];
  gate.onRosterChange(() => links.forEach((link) => void link.publish()));
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
        server.acceptPhoneSocket(socket, gate.staticPrivate, gate.options({ onAuthenticated: release }));
      },
      policy: async () => relayPolicy(await store.read()),
      admitEnrolment: (enrol) => gate.devices.admitsEnrolment(enrol),
      startTimer,
      log,
      enrolmentChecksPerMinute: deps.enrolmentChecksPerMinute,
    });
    links.push(link);
    link.start();
  }
  return {
    account,
    stop: () => links.forEach((link) => link.stop()),
  };
}
