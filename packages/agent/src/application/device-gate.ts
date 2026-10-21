import { REFUSAL, enrolKey, verifyEnrolProof } from '@perch/secure-channel';
import type { DeviceStorePort } from '../ports/device-store-port';
import type { PairingStorePort } from '../ports/pairing-store-port';
import { findPairing, redeemPairing } from './pairing';
import type { DeviceGate, EnrolmentVerdict, Redemption } from '../ports/device-gate-port';
import { enrolDevice, enrolmentMode, isRevokedRelayKey, mayEnrol, standingOf, type DeviceRoster, type EnrolmentMode } from './device-roster';

export interface RosterDevicesDeps {
  store: DeviceStorePort;
  // The pairing secrets `perch pair` handed out; each proves an enrolment like the token, once.
  pairings: PairingStorePort;
  now: () => Date;
  // This agent's account and the key derived from its token (enrolKey), to check enrolment proofs.
  account: string;
  enrolKey: Uint8Array;
  // Called after this agent wrote the roster, so the relay hears of a new device at once.
  onChange: () => void;
}

const unknownProof: Record<'pairing' | 'token' | 'unsaid', string> = {
  pairing: 'its pairing code is unknown (not one this agent issued in the last day)',
  token: 'its token proof did not verify (a wrong token)',
  unsaid: 'its proof matched neither the token nor a pairing code from the last day',
};

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} s`;
  const min = Math.round(s / 60);
  return min < 120 ? `${min} min` : `${Math.round(min / 60)} h`;
}

// The agent's device gate, over ~/.perch/devices.json.
export class RosterDevices implements DeviceGate {
  constructor(private readonly deps: RosterDevicesDeps) {}

  async check(x25519: string): Promise<{ standing: ReturnType<typeof standingOf>; enrolment: EnrolmentMode }> {
    const roster = await this.deps.store.read();
    return { standing: standingOf(roster, x25519), enrolment: enrolmentMode(roster) };
  }

  async enrol(device: { x25519: string; ed25519: string; name: string }, via: 'pairing' | 'token'): Promise<boolean> {
    // Enrolment may have been closed or turned off between the handshake and the credential.
    const roster = await this.deps.store.update((current) => (mayEnrol(current, via) ? enrolDevice(current, device, this.deps.now()) : current));
    this.deps.onChange();
    return standingOf(roster, device.x25519) === 'enrolled';
  }

  // Whether the relay may dial back for an unknown key that asks to enrol: enrolment is not
  // closed, the key is not revoked, and its proof shows the token (while token enrolment is on),
  // or a live pairing secret, over the relay's own nonce. The secret is not spent here: the handshake that follows may still fail,
  // and the phone would then need a new code. It is spent at `auth` (`redeemPairing`).
  // A dead secret's fate is told only to a proof made with it, so only the holder learns it.
  async admitsEnrolment(enrol: { device: string; nonce: string; proof: string; cred?: 'pairing' | 'token' }): Promise<EnrolmentVerdict> {
    const roster: DeviceRoster = await this.deps.store.read();
    if (!roster.enrolment) return { admitted: false, reason: REFUSAL.enrolmentClosed, detail: 'enrolment is closed' };
    if (isRevokedRelayKey(roster, enrol.device)) return { admitted: false, reason: REFUSAL.revoked, detail: 'the device is revoked' };
    const claim = { account: this.deps.account, nonce: enrol.nonce, device: enrol.device };
    if (verifyEnrolProof(this.deps.enrolKey, enrol.proof, claim)) {
      return mayEnrol(roster, 'token')
        ? { admitted: true }
        : { admitted: false, reason: REFUSAL.enrolmentOff, detail: 'token enrolment is off (only a pairing code enrols)' };
    }
    const pairing = findPairing(await this.deps.pairings.read(), (secret) => verifyEnrolProof(enrolKey(secret, this.deps.account), enrol.proof, claim), this.deps.now());
    switch (pairing?.state) {
      case 'live':
        return { admitted: true };
      case 'used':
        return { admitted: false, reason: REFUSAL.codeUsed, detail: 'its pairing code was already used' };
      case 'expired':
        return { admitted: false, reason: REFUSAL.codeExpired, detail: `its pairing code expired ${ago(pairing.agoMs)} ago` };
      default:
        return { admitted: false, reason: REFUSAL.proofInvalid, detail: unknownProof[enrol.cred ?? 'unsaid'] };
    }
  }

  // Spends a pairing secret for the device (X25519 key) about to be enrolled, binding it to that
  // device. Atomic across processes, so two phones racing with one code cannot both get in. A
  // secret this agent never issued (or has forgotten) gives no reason: it may be a token after all.
  async redeemPairing(secret: string, device: string): Promise<Redemption> {
    if (!(await this.deps.store.read()).enrolment) return { redeemed: false, reason: REFUSAL.enrolmentClosed };
    const outcome = await this.spend(secret, device);
    if (outcome === 'redeemed' || outcome === 'mine') return { redeemed: true, fresh: outcome === 'redeemed' };
    if (outcome === 'used') return { redeemed: false, reason: REFUSAL.codeUsed };
    if (outcome === 'expired') return { redeemed: false, reason: REFUSAL.codeExpired };
    return { redeemed: false };
  }

  // Spends a live secret an enrolled device presented, whatever enrolment is set to: the device
  // needs no code, and one left live would admit whoever else holds the link. True if it did.
  async burnPairing(secret: string, device: string): Promise<boolean> {
    return (await this.spend(secret, device)) === 'redeemed';
  }

  private async spend(secret: string, device: string): Promise<ReturnType<typeof redeemPairing>['outcome']> {
    // A secret this agent did not issue (or no longer keeps) changes nothing: answered without the
    // file's lock, so a stream of made-up ones cannot keep `perch pair` from writing it.
    if (redeemPairing(await this.deps.pairings.read(), secret, this.deps.now(), device).outcome === 'unknown') return 'unknown';
    let outcome = 'unknown' as ReturnType<typeof redeemPairing>['outcome'];
    await this.deps.pairings.update((list) => {
      const result = redeemPairing(list, secret, this.deps.now(), device);
      outcome = result.outcome;
      return result.list;
    });
    return outcome;
  }
}

// Notices a roster changed by someone else (`perch devices` in another process): the agent
// polls, since a rename-on-write defeats a file watch.
export class RosterMonitor {
  private last: string | null = null;

  constructor(
    private readonly store: DeviceStorePort,
    private readonly onChange: (roster: DeviceRoster) => void,
  ) {}

  async poll(): Promise<void> {
    let roster: DeviceRoster;
    try {
      roster = await this.store.read();
    } catch {
      return;
    }
    const text = JSON.stringify(roster);
    if (this.last !== null && text !== this.last) this.onChange(roster);
    this.last = text;
  }
}
