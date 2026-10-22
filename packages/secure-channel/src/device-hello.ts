// The payload of the phone's IK message 1: its Ed25519 relay key, so the agent can publish it to
// the relay once the device is enrolled, and a name to tell devices apart in `perch devices`.
// It is encrypted and bound to the phone's static key by the handshake. `proof` shows the phone
// holds that Ed25519 key: a signature over its X25519 key and the handshake hash the hello is
// sealed under, so it cannot name another phone's relay key nor replay a proof from another
// session.
import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { isEd25519PublicKey, verifyEd25519 } from './agent-auth';
import type { DeviceSigner } from './device-auth';
import { b64url } from './keys';

// Control characters (C0, DEL, C1) and bidi overrides: the name reaches the agent's journal and
// `perch devices`, where they could forge a line or rewrite the terminal.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeDeviceName(name: string): string {
  return name.replace(UNSAFE, '?');
}

const helloSchema = z.object({
  sig: z.string().refine(isEd25519PublicKey),
  name: z.string().max(64).transform(sanitizeDeviceName),
  proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/).optional(),
  // The phone asks to be served at once if its key is enrolled: `authResult` and the opening
  // replies right behind message 2, without waiting for its `auth`. An older agent ignores it.
  push: z.literal(true).optional().catch(undefined),
});

export type DeviceHello = z.infer<typeof helloSchema>;

const PROOF_LABEL = new TextEncoder().encode('perch-device-hello-v1\n');

function proofMessage(x25519Public: Uint8Array, handshakeHash: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(concatBytes(PROOF_LABEL, x25519Public, handshakeHash));
}

export async function signDeviceHello(sign: DeviceSigner, x25519Public: Uint8Array, handshakeHash: Uint8Array): Promise<string> {
  return b64url.encode(await sign(proofMessage(x25519Public, handshakeHash)));
}

export async function verifyDeviceHello(
  hello: DeviceHello,
  x25519Public: Uint8Array,
  handshakeHash: Uint8Array,
  subtle: SubtleCrypto | undefined = typeof crypto === 'undefined' ? undefined : crypto.subtle,
): Promise<boolean> {
  if (!hello.proof) return false;
  try {
    return await verifyEd25519(
      new Uint8Array(b64url.decode(hello.proof)),
      proofMessage(x25519Public, handshakeHash),
      new Uint8Array(b64url.decode(hello.sig)),
      subtle,
    );
  } catch {
    return false;
  }
}

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

// A short, stable name for a device key, shown by the phone's Settings and by `perch devices`
// so the two can be matched by eye. Not a security boundary: enrolment compares whole keys.
export function deviceFingerprint(x25519PublicKey: string): string {
  const hex = Array.from(sha256(b64url.decode(x25519PublicKey)).subarray(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}
