import { join } from 'node:path';
import { DEFAULT_PWA_ORIGIN } from '../application/setup-machine';

export interface AgentConfig {
  machineId: string;
  token: string | undefined;
  // The loopback port Claude Code's hooks post to. Phones never reach it.
  port: number;
  // The loopback port phones' WebSockets reach, through whatever publishes it (tailscale serve,
  // Funnel, a reverse proxy). It serves upgrades only.
  phonePort: number;
  // Where phones reach the phone port from outside (PERCH_PHONE_ADDRESSES), in order.
  phoneAddresses: string[];
  projectRoots: string[];
  // The default path pairing links hand a phone (PERCH_DEFAULT_PATH); none unless set.
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
  // The sockets the Perch extension for Pi binds, one per workspace (docs/MESSAGING.md).
  inboxDir: string;
  sessionPrefix: string;
  // The agent's identity, whose X25519 public key every phone pins. The file keeps the name it had
  // when relays existed.
  agentKeyPath: string;
  // The phones this agent accepts (~/.perch/devices.json), managed by `perch devices`.
  devicesPath: string;
  // The phone pairing secrets `perch pair` hands out (~/.perch/pairing.json).
  pairingPath: string;
  // Where phones open the PWA; the origin of the pairing links `perch pair` prints
  // (PERCH_PWA_ORIGIN, default https://tarfa.app).
  pwaOrigin: string;
  // false when PERCH_STATS turns the machine load strip off, e.g. for a second Linux user on a
  // machine whose load another agent already reports.
  stats?: false;
  // The ALSA device Claude voice plays into (default plughw:Loopback,0). Users sharing a machine
  // each take their own loopback subdevice, paired with the capture side of their ~/.asoundrc.
  voiceDevice?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv, home: string): AgentConfig {
  const machineId = env.PERCH_MACHINE_ID;
  if (!machineId) {
    throw new Error('PERCH_MACHINE_ID is required');
  }
  const projectRoots = env.PERCH_PROJECT_ROOTS
    ? env.PERCH_PROJECT_ROOTS.split(':').filter((p) => p.length > 0)
    : [join(home, 'workspace')];

  let port = 8787;
  if (env.PERCH_PORT) {
    port = Number.parseInt(env.PERCH_PORT, 10);
    if (Number.isNaN(port)) {
      throw new Error('PERCH_PORT must be a number');
    }
  }

  let phonePort = 8797;
  if (env.PERCH_PHONE_PORT !== undefined) {
    phonePort = /^\d+$/.test(env.PERCH_PHONE_PORT.trim()) ? Number(env.PERCH_PHONE_PORT.trim()) : Number.NaN;
    if (!(phonePort >= 1 && phonePort <= 65535)) {
      throw new Error('PERCH_PHONE_PORT must be a port number (1-65535)');
    }
  }

  return {
    machineId,
    token: env.PERCH_TOKEN,
    port,
    phonePort,
    phoneAddresses: phoneAddresses(env),
    projectRoots,
    recentStorePath: join(home, '.perch', 'recent.json'),
    statusStorePath: join(home, '.perch', 'status.json'),
    hiddenFoldersPath: join(home, '.perch', 'hidden-folders.json'),
    launchersPath: join(home, '.perch', 'launchers.json'),
    // Usually a symlink to a vocabulary kept with the user's own dotfiles, so one list can
    // serve every machine; PERCH_KEYTERMS_PATH points at it directly instead.
    keytermsPath: env.PERCH_KEYTERMS_PATH ?? join(home, '.perch', 'keyterms.txt'),
    clientLogPath: join(home, '.perch', 'client-log.jsonl'),
    hookEventLogPath: join(home, '.perch', 'hook-events.jsonl'),
    messageLogPath: join(home, '.perch', 'messages.jsonl'),
    workspaceLogPath: join(home, '.perch', 'workspace-log.jsonl'),
    parkedStorePath: join(home, '.perch', 'parked.json'),
    liveSnapshotPath: join(home, '.perch', 'live.json'),
    // Claude Code's own registry, not Perch's — read-only, and absent on a machine
    // without Claude Code.
    claudeSessionsDir: join(home, '.claude', 'sessions'),
    inboxDir: join(home, '.perch', 'inbox'),
    sessionPrefix: 'perch-',
    agentKeyPath: join(home, '.perch', 'relay-key.json'),
    devicesPath: join(home, '.perch', 'devices.json'),
    pairingPath: join(home, '.perch', 'pairing.json'),
    pwaOrigin: env.PERCH_PWA_ORIGIN?.trim() || DEFAULT_PWA_ORIGIN,
    ...(env.PERCH_DEFAULT_PATH ? { defaultPath: env.PERCH_DEFAULT_PATH } : {}),
    ...(['off', '0', 'false'].includes(env.PERCH_STATS?.trim().toLowerCase() ?? '') ? { stats: false as const } : {}),
    ...(env.PERCH_VOICE_DEVICE?.trim() ? { voiceDevice: env.PERCH_VOICE_DEVICE.trim() } : {}),
  };
}

export function assertServerConfig(
  config: AgentConfig,
): asserts config is AgentConfig & { token: string } {
  if (!config.token) {
    throw new Error('PERCH_TOKEN is required to run the agent server');
  }
}

// Settings that are ignored or missing, for the agent to print at startup.
export function configWarnings(env: NodeJS.ProcessEnv): string[] {
  const warnings: string[] = [];
  const relays = ['PERCH_RELAY_URLS', 'PERCH_RELAY_URL'].filter((name) => env[name]?.trim());
  if (relays.length > 0) warnings.push(`relays are gone; remove ${relays.join(' and ')} from deploy/agent.env`);
  if (phoneAddresses(env).length === 0) {
    warnings.push('no PERCH_PHONE_ADDRESSES: phones reach this agent only once its phone port is published (tailscale serve, a reverse proxy)');
  }
  const host = env.PERCH_HOST?.trim();
  if (host && host !== '127.0.0.1' && host !== 'localhost') {
    warnings.push(`PERCH_HOST=${host} is ignored: the agent listens on 127.0.0.1 only, and phones reach it through its published phone port`);
  }
  return warnings;
}

function phoneAddresses(env: Record<string, string | undefined>): string[] {
  return (env.PERCH_PHONE_ADDRESSES ?? '').split(',').map((url) => url.trim()).filter(Boolean);
}
