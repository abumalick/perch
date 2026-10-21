import type { RegistryRoom } from './registry-room';
import type { RelayRoom } from './relay-room';

export interface Env {
  RELAY: DurableObjectNamespace<RelayRoom>;
  // The account registry: one object, named `registry`.
  REGISTRY: DurableObjectNamespace<RegistryRoom>;
  // A secret: the relay's join key (32 bytes, base64url). Unset, machines cannot join (501).
  JOIN_KEY?: string;
  // A secret: the operator's admin key, which lists and removes machines. Unset, those answer 501.
  ADMIN_KEY?: string;
  // "1" logs each forwarded frame's size and whether it parses as JSON (never its content).
  RELAY_AUDIT?: string;
  // Optional overrides of the relay core's limits (positive integers); unset in production.
  RELAY_DIAL_TIMEOUT_MS?: string;
  RELAY_MAX_PENDING?: string;
  RELAY_MAX_PAIRS?: string;
  RELAY_MAX_ENROLMENTS?: string;
  RELAY_JOIN_MAX?: string;
  RELAY_JOIN_WINDOW_MS?: string;
}
