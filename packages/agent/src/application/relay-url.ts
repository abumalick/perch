// A relay URL with its trailing slashes removed, so `wss://relay/` and `wss://relay` are one relay.
export function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// A ws:// relay off this machine: the agent's signed upgrade headers and its published policy
// would cross the network in the clear. Loopback is the one place plain ws is fine.
export function isCleartextRemote(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'ws:' && !LOOPBACK.has(parsed.hostname);
  } catch {
    return false;
  }
}
