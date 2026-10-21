import { isJoinKey } from '@perch/secure-channel';
import { DEFAULT_JOIN_LIMIT, type JoinLimit } from './registry.ts';

// What a host may tune. Unset means the relay core's default; the frame limit is not here
// because it is fixed by the Noise message size, not a choice.
export interface RelayLimits {
  dialTimeoutMs?: number;
  maxPending?: number;
  maxPairs?: number;
  maxEnrolments?: number;
}

const LIMIT_KEYS = ['dialTimeoutMs', 'maxPending', 'maxPairs', 'maxEnrolments'] as const;

function positiveInteger(key: string, value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new Error(`${key} must be a positive integer`);
  return n;
}

// Numbers from a JSON file, or strings from a Worker's environment.
export function parseRelayLimits(raw: Partial<Record<(typeof LIMIT_KEYS)[number], unknown>>): RelayLimits {
  const limits: RelayLimits = {};
  for (const key of LIMIT_KEYS) {
    const n = positiveInteger(key, raw[key]);
    if (n !== undefined) limits[key] = n;
  }
  return limits;
}

// How many join-key requests one client address may make per window.
export function parseJoinLimit(raw: { joinMax?: unknown; joinWindowMs?: unknown }): JoinLimit {
  return {
    max: positiveInteger('joinMax', raw.joinMax) ?? DEFAULT_JOIN_LIMIT.max,
    windowMs: positiveInteger('joinWindowMs', raw.joinWindowMs) ?? DEFAULT_JOIN_LIMIT.windowMs,
  };
}

// The self-hosted relay's configuration file (~/.perch/relay/config.json).
export interface RelayConfig {
  host: string;
  port: number;
  limits: RelayLimits;
  // The secret a machine proves to register itself (`perch connect`); unset, joining is off.
  joinKey?: string;
  // The operator's key to list and remove accounts (`perch-relay machines`); unset, they answer 501.
  adminKey?: string;
  joinLimit: JoinLimit;
  // The header a proxy on the same machine names the client in; unset, none is believed.
  clientIpHeader?: string;
}

const DEFAULT_RELAY_HOST = '127.0.0.1';
export const DEFAULT_RELAY_PORT = 8450;
const CONFIG_KEYS = new Set<string>(['host', 'port', 'clientIpHeader', 'joinKey', 'adminKey', 'joinMax', 'joinWindowMs', ...LIMIT_KEYS]);

export function parseRelayConfig(text: string): RelayConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('relay config is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('relay config must be a JSON object');
  }
  const raw = parsed as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`relay config: unknown key ${JSON.stringify(key)}`);
  }
  const { host = DEFAULT_RELAY_HOST, port = DEFAULT_RELAY_PORT, joinKey, adminKey } = raw;
  if (typeof host !== 'string' || !host) throw new Error('relay config: host must be a string');
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('relay config: port must be 0-65535');
  }
  if (joinKey !== undefined && !isJoinKey(joinKey)) throw new Error('relay config: joinKey must be 32 bytes in base64url');
  if (adminKey !== undefined && !isJoinKey(adminKey)) throw new Error('relay config: adminKey must be 32 bytes in base64url');
  const { clientIpHeader = null } = raw;
  if (clientIpHeader !== null && (typeof clientIpHeader !== 'string' || !/^[A-Za-z0-9-]+$/.test(clientIpHeader))) {
    throw new Error('relay config: clientIpHeader must be a header name, or null');
  }
  const config: RelayConfig = {
    host,
    port,
    limits: parseRelayLimits(raw),
    joinLimit: parseJoinLimit(raw),
  };
  if (joinKey !== undefined) config.joinKey = joinKey;
  if (adminKey !== undefined) config.adminKey = adminKey;
  if (clientIpHeader) config.clientIpHeader = clientIpHeader.toLowerCase();
  return config;
}
