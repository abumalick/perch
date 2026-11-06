// The payload of the phone's IK message 1: its Ed25519 key (`sig`, which the roster keeps) and a
// name to tell devices apart in `tarfa devices`. It is encrypted and bound to the phone's static
// key by the handshake. The agent knows a phone by that static key alone.
import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64url, isEd25519PublicKey } from './keys';

// Control characters (C0, DEL, C1) and bidi overrides: the name reaches the agent's journal and
// `tarfa devices`, where they could forge a line or rewrite the terminal.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeDeviceName(name: string): string {
  return name.replace(UNSAFE, '?');
}

const helloSchema = z.object({
  sig: z.string().refine(isEd25519PublicKey),
  name: z.string().max(64).transform(sanitizeDeviceName),
  // The signature relays admitted a phone by. PWAs built before direct connections still send it;
  // nothing reads it.
  proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/).optional(),
  // The phone asks to be served at once if its key is enrolled: `authResult` and the opening
  // replies right behind message 2, without waiting for its `auth`. An older agent ignores it.
  push: z.literal(true).optional().catch(undefined),
});

export type DeviceHello = z.infer<typeof helloSchema>;

export function encodeDeviceHello(hello: z.input<typeof helloSchema>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(hello));
}

export function parseDeviceHello(payload: Uint8Array): DeviceHello | null {
  try {
    const result = helloSchema.safeParse(JSON.parse(new TextDecoder().decode(payload)));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// A short, stable name for a device key, shown by the phone's Settings and by `tarfa devices`
// so the two can be matched by eye. Not a security boundary: enrolment compares whole keys.
export function deviceFingerprint(x25519PublicKey: string): string {
  const hex = Array.from(sha256(b64url.decode(x25519PublicKey)).subarray(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}
