import { b64url } from '@perch/secure-channel';

// A relay machine's agent key: the agent's X25519 public key in base64url, as `perch relay-key`
// prints it. Anything that does not decode to exactly 32 bytes is refused, never guessed at.
export function parseAgentKey(value: string | undefined): Uint8Array | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    const key = b64url.decode(text);
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}
