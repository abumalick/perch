import type { AgentRefusal } from '@perch/secure-channel';
import type { DeviceStanding, EnrolmentMode } from '../application/device-roster';

// Whether an unknown key may enrol; a refusal carries the reason the phone is told and, for the
// agent's log, what exactly went wrong.
export type EnrolmentVerdict = { admitted: true } | { admitted: false; reason: AgentRefusal; detail: string };

// `fresh`: spent just now, rather than presented again by the device that spent it.
export type Redemption = { redeemed: true; fresh: boolean } | { redeemed: false; reason?: AgentRefusal };

// The agent's own record of which phones it accepts. It never takes the relay's word for it.
export interface DeviceGate {
  check(x25519: string): Promise<{ standing: DeviceStanding; enrolment: EnrolmentMode }>;
  // `via`: what the phone proved itself with, since enrolment may be open to pairing codes only.
  // Resolves to whether the device is enrolled once the roster is written.
  enrol(device: { x25519: string; ed25519: string; name: string }, via: 'pairing' | 'token'): Promise<boolean>;
  // Spends a phone pairing secret for this device, live and with enrolment not closed; else why
  // not, when it knows.
  redeemPairing(secret: string, device: string): Promise<Redemption>;
  // Spends a live secret an enrolled device presented; true if it did.
  burnPairing(secret: string, device: string): Promise<boolean>;
}
