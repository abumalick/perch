import { REFUSAL } from '@tarfa/secure-channel';
import type { DeviceStorePort } from '../ports/device-store-port';
import type { PairingStorePort } from '../ports/pairing-store-port';
import { redeemPairing } from './pairing';
import type { DeviceGate, Redemption } from '../ports/device-gate-port';
import { enrolDevice, enrolmentMode, mayEnrol, standingOf, type DeviceRoster, type EnrolmentMode } from './device-roster';

export interface RosterDevicesDeps {
  store: DeviceStorePort;
  // The pairing secrets `tarfa pair` handed out; each proves an enrolment like the token, once.
  pairings: PairingStorePort;
  now: () => Date;
  // Called after this agent wrote the roster, so the gate's copy knows a new device at once.
  onChange: () => void;
}

// The agent's device gate, over ~/.tarfa/devices.json.
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
    // file's lock, so a stream of made-up ones cannot keep `tarfa pair` from writing it.
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

// Notices a roster changed by someone else (`tarfa devices` in another process): the agent
// polls, since a rename-on-write defeats a file watch.
export class RosterMonitor {
  private last: string | null = null;

  // `onRead`: every roster read, the first included, for what keeps a copy of it.
  constructor(
    private readonly store: DeviceStorePort,
    private readonly onChange: (roster: DeviceRoster) => void,
    private readonly onRead?: (roster: DeviceRoster) => void,
  ) {}

  async poll(): Promise<void> {
    let roster: DeviceRoster;
    try {
      roster = await this.store.read();
    } catch {
      return;
    }
    this.onRead?.(roster);
    const text = JSON.stringify(roster);
    if (this.last !== null && text !== this.last) this.onChange(roster);
    this.last = text;
  }
}
