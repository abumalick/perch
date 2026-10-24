import { join } from 'node:path';
import { isCleartextRemote, withoutTrailingSlash } from '../application/relay-url';

export interface AgentConfig {
  machineId: string;
  token: string | undefined;
  // The loopback port Claude Code's hooks post to. Phones never reach it: they come through relays.
  port: number;
  projectRoots: string[];
  // The default path pairing links hand a phone (PERCH_DEFAULT_PATH); none unless set.
  defaultPath?: string;
  recentStorePath: string;
  statusStorePath: string;
  hiddenFoldersPath: string;
  commandsPath: string;
  launchersPath: string;
  keytermsPath: string;
  clientLogPath: string;
  hookEventLogPath: string;
  workspaceLogPath: string;
  parkedStorePath: string;
  liveSnapshotPath: string;
  claudeSessionsDir: string;
  sessionPrefix: string;
  // The relays the agent also serves clients through, one RelayLink each (e.g. the Cloudflare
  // Worker and a self-hosted relay), from PERCH_RELAY_URLS. The account comes from the key
  // file, not the URL, so it is the same on every relay.
  relayUrls: string[];
  relayKeyPath: string;
  // The phones enrolled for the relay path (~/.perch/devices.json), managed by `perch devices`.
  devicesPath: string;
  // The phone pairing secrets `perch pair` hands out (~/.perch/pairing.json).
  pairingPath: string;
  // Where phones open the PWA; the origin of the pairing links `perch pair` prints.
  pwaOrigin?: string;
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

  return {
    machineId,
    token: env.PERCH_TOKEN,
    port,
    projectRoots,
    recentStorePath: join(home, '.perch', 'recent.json'),
    statusStorePath: join(home, '.perch', 'status.json'),
    hiddenFoldersPath: join(home, '.perch', 'hidden-folders.json'),
    commandsPath: join(home, '.perch', 'commands.json'),
    launchersPath: join(home, '.perch', 'launchers.json'),
    // Usually a symlink to a vocabulary kept with the user's own dotfiles, so one list can
    // serve every machine; PERCH_KEYTERMS_PATH points at it directly instead.
    keytermsPath: env.PERCH_KEYTERMS_PATH ?? join(home, '.perch', 'keyterms.txt'),
    clientLogPath: join(home, '.perch', 'client-log.jsonl'),
    hookEventLogPath: join(home, '.perch', 'hook-events.jsonl'),
    workspaceLogPath: join(home, '.perch', 'workspace-log.jsonl'),
    parkedStorePath: join(home, '.perch', 'parked.json'),
    liveSnapshotPath: join(home, '.perch', 'live.json'),
    // Claude Code's own registry, not Perch's — read-only, and absent on a machine
    // without Claude Code.
    claudeSessionsDir: join(home, '.claude', 'sessions'),
    sessionPrefix: 'perch-',
    relayUrls: relayUrls(env),
    relayKeyPath: join(home, '.perch', 'relay-key.json'),
    devicesPath: join(home, '.perch', 'devices.json'),
    pairingPath: join(home, '.perch', 'pairing.json'),
    ...(env.PERCH_PWA_ORIGIN ? { pwaOrigin: env.PERCH_PWA_ORIGIN } : {}),
    ...(env.PERCH_DEFAULT_PATH ? { defaultPath: env.PERCH_DEFAULT_PATH } : {}),
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
  const single = env.PERCH_RELAY_URL?.trim();
  if (single) warnings.push(`PERCH_RELAY_URL is ignored: move ${single} into PERCH_RELAY_URLS in deploy/agent.env`);
  for (const url of listedRelayUrls(env).filter(isCleartextRemote)) {
    warnings.push(`${url} is ignored: a relay off this machine must be wss://, or its upgrades travel in the clear`);
  }
  if (relayUrls(env).length === 0) warnings.push('no relay in PERCH_RELAY_URLS: no phone can reach this agent (see `perch connect`)');
  if (env.PERCH_RELAY_ALLOW_NK !== undefined) {
    warnings.push('PERCH_RELAY_ALLOW_NK is ignored: phones without a device key are no longer served; remove it from deploy/agent.env');
  }
  const host = env.PERCH_HOST?.trim();
  if (host && host !== '127.0.0.1' && host !== 'localhost') {
    warnings.push(`PERCH_HOST=${host} is ignored: the agent listens on 127.0.0.1 only, and phones reach it through its relays`);
  }
  return warnings;
}

function listedRelayUrls(env: Record<string, string | undefined>): string[] {
  const listed = (env.PERCH_RELAY_URLS ?? '').split(/[\s,]+/);
  return [...new Set(listed.map((url) => withoutTrailingSlash(url.trim())).filter(Boolean))];
}

function relayUrls(env: Record<string, string | undefined>): string[] {
  return listedRelayUrls(env).filter((url) => !isCleartextRemote(url));
}
