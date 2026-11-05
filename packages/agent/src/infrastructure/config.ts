import { join } from 'node:path';
import { DEFAULT_PWA_ORIGIN } from '../application/setup-machine';
import { resolveAgentKeyPath, resolveStateDir } from './state-dir';
import { legacyEnvNames, renamedEnvName, withLegacyEnv } from '../application/legacy-env';

export { withLegacyEnv };

export interface AgentConfig {
  // ~/.tarfa, or a ~/.perch the agent has not moved yet (state-dir.ts).
  stateDir: string;
  machineId: string;
  token: string | undefined;
  // The loopback port Claude Code's hooks post to. Phones never reach it.
  port: number;
  // The loopback port phones' WebSockets reach, through whatever publishes it (tailscale serve,
  // Funnel, a reverse proxy). It serves upgrades only.
  phonePort: number;
  // Where phones reach the phone port from outside (TARFA_PHONE_ADDRESSES), in order.
  phoneAddresses: string[];
  projectRoots: string[];
  // The default path pairing links hand a phone (TARFA_DEFAULT_PATH); none unless set.
  defaultPath?: string;
  recentStorePath: string;
  statusStorePath: string;
  hiddenFoldersPath: string;
  launchersPath: string;
  keytermsPath: string;
  clientLogPath: string;
  hookEventLogPath: string;
  messageLogPath: string;
  workspaceLogPath: string;
  parkedStorePath: string;
  liveSnapshotPath: string;
  claudeSessionsDir: string;
  // The sockets the Tarfa extension for Pi binds, one per workspace (docs/MESSAGING.md).
  inboxDir: string;
  sessionPrefix: string;
  // The agent's identity, whose X25519 public key every phone pins.
  agentKeyPath: string;
  // The phones this agent accepts (~/.tarfa/devices.json), managed by `tarfa devices`.
  devicesPath: string;
  // The phone pairing secrets `tarfa pair` hands out (~/.tarfa/pairing.json).
  pairingPath: string;
  // Where phones open the PWA; the origin of the pairing links `tarfa pair` prints
  // (TARFA_PWA_ORIGIN, default https://tarfa.app).
  pwaOrigin: string;
  // false when TARFA_STATS turns the machine load strip off, e.g. for a second Linux user on a
  // machine whose load another agent already reports.
  stats?: false;
  // The ALSA device Claude voice plays into (default plughw:Loopback,0). Users sharing a machine
  // each take their own loopback subdevice, paired with the capture side of their ~/.asoundrc.
  voiceDevice?: string;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv, home: string): AgentConfig {
  const env = withLegacyEnv(rawEnv);
  const stateDir = resolveStateDir(home);
  const machineId = env.TARFA_MACHINE_ID;
  if (!machineId) {
    throw new Error('TARFA_MACHINE_ID is required');
  }
  const projectRoots = env.TARFA_PROJECT_ROOTS
    ? env.TARFA_PROJECT_ROOTS.split(':').filter((p) => p.length > 0)
    : [join(home, 'workspace')];

  let port = 8787;
  if (env.TARFA_PORT) {
    port = Number.parseInt(env.TARFA_PORT, 10);
    if (Number.isNaN(port)) {
      throw new Error('TARFA_PORT must be a number');
    }
  }

  let phonePort = 8797;
  if (env.TARFA_PHONE_PORT !== undefined) {
    phonePort = /^\d+$/.test(env.TARFA_PHONE_PORT.trim()) ? Number(env.TARFA_PHONE_PORT.trim()) : Number.NaN;
    if (!(phonePort >= 1 && phonePort <= 65535)) {
      throw new Error('TARFA_PHONE_PORT must be a port number (1-65535)');
    }
  }

  return {
    stateDir,
    machineId,
    token: env.TARFA_TOKEN,
    port,
    phonePort,
    phoneAddresses: phoneAddresses(env),
    projectRoots,
    recentStorePath: join(stateDir, 'recent.json'),
    statusStorePath: join(stateDir, 'status.json'),
    hiddenFoldersPath: join(stateDir, 'hidden-folders.json'),
    launchersPath: join(stateDir, 'launchers.json'),
    // Usually a symlink to a vocabulary kept with the user's own dotfiles, so one list can
    // serve every machine; TARFA_KEYTERMS_PATH points at it directly instead.
    keytermsPath: env.TARFA_KEYTERMS_PATH ?? join(stateDir, 'keyterms.txt'),
    clientLogPath: join(stateDir, 'client-log.jsonl'),
    hookEventLogPath: join(stateDir, 'hook-events.jsonl'),
    messageLogPath: join(stateDir, 'messages.jsonl'),
    workspaceLogPath: join(stateDir, 'workspace-log.jsonl'),
    parkedStorePath: join(stateDir, 'parked.json'),
    liveSnapshotPath: join(stateDir, 'live.json'),
    // Claude Code's own registry, not Tarfa's — read-only, and absent on a machine
    // without Claude Code.
    claudeSessionsDir: join(home, '.claude', 'sessions'),
    inboxDir: join(stateDir, 'inbox'),
    // The prefix of the oldest workspace ids, perch-<6 hex>: data from before the rename, kept as is.
    sessionPrefix: 'perch-',
    agentKeyPath: resolveAgentKeyPath(stateDir),
    devicesPath: join(stateDir, 'devices.json'),
    pairingPath: join(stateDir, 'pairing.json'),
    pwaOrigin: env.TARFA_PWA_ORIGIN?.trim() || DEFAULT_PWA_ORIGIN,
    ...(env.TARFA_DEFAULT_PATH ? { defaultPath: env.TARFA_DEFAULT_PATH } : {}),
    ...(['off', '0', 'false'].includes(env.TARFA_STATS?.trim().toLowerCase() ?? '') ? { stats: false as const } : {}),
    ...(env.TARFA_VOICE_DEVICE?.trim() ? { voiceDevice: env.TARFA_VOICE_DEVICE.trim() } : {}),
  };
}

export function assertServerConfig(
  config: AgentConfig,
): asserts config is AgentConfig & { token: string } {
  if (!config.token) {
    throw new Error('TARFA_TOKEN is required to run the agent server');
  }
}

// Settings that are ignored or missing, for the agent to print at startup.
export function configWarnings(rawEnv: NodeJS.ProcessEnv): string[] {
  const env = withLegacyEnv(rawEnv);
  const warnings = legacyEnvNames(rawEnv).map(
    (name) => `${name} is read as ${renamedEnvName(name)} for one release: rename it in deploy/agent.env (tarfa setup does)`,
  );
  const relays = ['TARFA_RELAY_URLS', 'TARFA_RELAY_URL'].filter((name) => env[name]?.trim());
  if (relays.length > 0) warnings.push(`relays are gone; remove ${relays.join(' and ')} from deploy/agent.env`);
  if (phoneAddresses(env).length === 0) {
    warnings.push('no TARFA_PHONE_ADDRESSES: phones reach this agent only once its phone port is published (tailscale serve, a reverse proxy)');
  }
  const host = env.TARFA_HOST?.trim();
  if (host && host !== '127.0.0.1' && host !== 'localhost') {
    warnings.push(`TARFA_HOST=${host} is ignored: the agent listens on 127.0.0.1 only, and phones reach it through its published phone port`);
  }
  return warnings;
}

function phoneAddresses(env: Record<string, string | undefined>): string[] {
  return (env.TARFA_PHONE_ADDRESSES ?? '').split(',').map((url) => url.trim()).filter(Boolean);
}

