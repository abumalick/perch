import type { AgentMessage, ClientMessage } from '@perch/contracts';
import { MachineConnection, type ConnectionDiagnostic, type ConnectionStatus } from './machine-connection';
import type { SocketFactory } from './ports/socket';
import type { WorkspaceAggregator } from './workspace-aggregator';
import { isConnectable, isRelayMachine, type MachineConfig } from './settings-store';
import type { RefusalContext } from './refusal';

export interface ConnectionManagerDeps {
  // Sockets end-to-end encrypted to the given agent key. The token (or pairing secret) proves,
  // inside the relay handshake, that this device's key may be enrolled.
  secureSocketFactory: (
    agentKey: string,
    token: string,
    credential: RefusalContext['credential'],
    onPhase: (phase: string, detail: string) => void,
  ) => SocketFactory;
  aggregator: WorkspaceAggregator;
  onMessage: (machineId: string, message: AgentMessage) => void;
  onStatus: (machineId: string, status: ConnectionStatus) => void;
  onDiagnostic?: (machineId: string, diagnostic: ConnectionDiagnostic) => void;
  // A phase of a relay connect (challenge fetch, socket open, handshake) with its timing.
  onPhase?: (machineId: string, phase: string, detail: string) => void;
  // The agent said this entry's device key is enrolled (`all`: its token and pairing secret are to
  // be forgotten), or an older agent spent its pairing secret (`pairing`). The store persists it.
  onCredentialsSpent?: (machineId: string, scope: 'all' | 'pairing') => void;
  schedule?: (fn: () => void, ms: number) => void;
  now?: () => number;
}

// What the connection authenticates with: a pairing secret while the entry holds one (it is what
// the machine is expecting from this phone), else the token. A paired entry whose secret is spent
// has neither: its enrolled device key is what the agent accepts.
function credential(config: MachineConfig): string {
  return config.pairing || config.token || '';
}

function credentialKind(config: MachineConfig): RefusalContext['credential'] {
  return config.pairing ? 'pairing' : config.token ? 'token' : 'none';
}

export class ConnectionManager {
  private readonly connections = new Map<string, MachineConnection>();
  // Each entry as it connects now: its credential is dropped here as soon as it is spent, so a
  // reconnect proves nothing with it before the store has rebuilt anything.
  private readonly configs = new Map<string, MachineConfig>();
  // When each machine's connect attempt began, until its workspace list arrives (the `list` phase).
  private readonly listPending = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: ConnectionManagerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  setMachines(configs: MachineConfig[]): void {
    const wanted = new Set(configs.filter(isConnectable).map((c) => c.id));
    for (const [id, conn] of this.connections) {
      if (!wanted.has(id)) {
        conn.close();
        this.connections.delete(id);
        this.configs.delete(id);
        this.deps.aggregator.setMachineOffline(id);
      }
    }
    for (const config of configs) {
      if (!isRelayMachine(config)) {
        this.notConnecting(config.id, 'old direct entry — no longer supported; pair this machine again');
        continue;
      }
      if (config.enabled === false) continue;
      this.connections.get(config.id)?.close();
      this.configs.set(config.id, config);
      const conn = new MachineConnection({
        url: config.url,
        token: credential(config),
        socketFactory: (url) => this.socketFactoryFor(this.configs.get(config.id) ?? config)(url),
        onCredentialsSpent: (scope) => {
          const current = this.configs.get(config.id) ?? config;
          this.configs.set(config.id, scope === 'all' ? { ...current, token: '', pairing: undefined } : { ...current, pairing: undefined });
          this.deps.onCredentialsSpent?.(config.id, scope);
        },
        schedule: this.deps.schedule,
        now: this.now,
        refusalContext: { machine: config.name, credential: credentialKind(config) },
        onDiagnostic: (diagnostic) => this.deps.onDiagnostic?.(config.id, diagnostic),
        onMessage: (message) => {
          const since = this.listPending.get(config.id);
          if (message.type === 'workspaces' && since !== undefined) {
            this.listPending.delete(config.id);
            this.deps.onPhase?.(config.id, 'list', `${this.now() - since}ms`);
          }
          this.deps.aggregator.apply(config.id, message);
          this.deps.onMessage(config.id, message);
        },
        onStatus: (status) => {
          if (status === 'connecting') this.listPending.set(config.id, this.now());
          if (status === 'offline') {
            this.deps.aggregator.setMachineOffline(config.id);
          } else if (status === 'online') {
            // The agent only returns workspaces in response to `list`; request it on
            // every (re)connect so the list populates and re-syncs after a reconnect.
            this.connections.get(config.id)?.send({ type: 'list' });
            // Same deal for the keyboard bar's command shortcuts: asking on every
            // (re)connect is what picks up an edit to the agent's ~/.perch/commands.json.
            this.connections.get(config.id)?.send({ type: 'listCommands' });
            // And the dictation vocabulary, for the same reason: asking on every (re)connect
            // is what picks up an edit to the agent's ~/.perch/keyterms.txt.
            this.connections.get(config.id)?.send({ type: 'listKeyterms' });
          }
          this.deps.onStatus(config.id, status);
        },
      });
      this.connections.set(config.id, conn);
      conn.connect();
    }
  }

  private notConnecting(machineId: string, message: string): void {
    this.deps.aggregator.setMachineOffline(machineId);
    this.deps.onStatus(machineId, 'offline');
    this.deps.onDiagnostic?.(machineId, { message, at: this.now() });
  }

  // A machine is never reached in plaintext, which would hand its token to the relay: without a
  // valid agent key it gets no socket at all (setMachines checks the key first).
  private socketFactoryFor(config: MachineConfig): SocketFactory {
    return this.deps.secureSocketFactory(config.agentKey!.trim(), credential(config), credentialKind(config), (phase, detail) =>
      this.deps.onPhase?.(config.id, phase, detail),
    );
  }

  send(machineId: string, message: ClientMessage): void {
    this.connections.get(machineId)?.send(message);
  }

  // Manually resume a machine that gave up auto-retrying (see MachineConnection.reconnect).
  reconnect(machineId: string): void {
    this.connections.get(machineId)?.reconnect();
  }

  // See MachineConnection.resetBackoff.
  resetBackoff(machineId: string): void {
    this.connections.get(machineId)?.resetBackoff();
  }

  // Probe a machine's link immediately (see MachineConnection.checkLiveness).
  checkLiveness(machineId: string): void {
    this.connections.get(machineId)?.checkLiveness();
  }

  stop(): void {
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
  }
}
