import { describe, expect, it } from 'vitest';
import { enrolKey, enrolProof, generateDeviceKeys } from '@perch/secure-channel';
import type { DeviceStorePort } from '../ports/device-store-port';
import type { PairingStorePort } from '../ports/pairing-store-port';
import { PAIRING_TTL_MS, addPairing, redeemPairing, type Pairing } from './pairing';
import { EMPTY_ROSTER, revokeDevice, withEnrolmentMode, type DeviceRoster } from './device-roster';
import { RosterDevices, RosterMonitor } from './device-gate';

class MemoryDeviceStore implements DeviceStorePort {
  constructor(public roster: DeviceRoster = EMPTY_ROSTER) {}
  async read() {
    return this.roster;
  }
  async update(change: (r: DeviceRoster) => DeviceRoster) {
    this.roster = change(this.roster);
    return this.roster;
  }
}

class MemoryPairingStore implements PairingStorePort {
  updates = 0;
  constructor(public list: Pairing[] = []) {}
  async read() {
    return this.list;
  }
  async update(change: (l: Pairing[]) => Pairing[]) {
    this.updates += 1;
    this.list = change(this.list);
    return this.list;
  }
}

const account = 'acct';
const SECRET = 's'.repeat(43);
const key = enrolKey('token', account);

function setup(roster?: DeviceRoster) {
  const store = new MemoryDeviceStore(roster);
  const pairings = new MemoryPairingStore(addPairing([], SECRET, new Date(0)));
  let changes = 0;
  let now = new Date(0);
  const devices = new RosterDevices({ store, pairings, now: () => now, account, enrolKey: key, onChange: () => (changes += 1) });
  return { store, pairings, devices, changes: () => changes, at: (ms: number) => (now = new Date(ms)) };
}

const ADMITTED = { admitted: true };
const refused = (reason: string) => expect.objectContaining({ admitted: false, reason });

function phone() {
  const k = generateDeviceKeys();
  return { x25519: k.x25519.publicKey, ed25519: k.ed25519.publicKey, name: 'p' };
}

describe('RosterDevices', () => {
  it('enrols a device and reports the change', async () => {
    const { devices, changes } = setup();
    const p = phone();
    expect(await devices.check(p.x25519)).toEqual({ standing: 'unknown', enrolment: 'on' });
    await devices.enrol(p, 'token');
    expect(await devices.check(p.x25519)).toEqual({ standing: 'enrolled', enrolment: 'on' });
    expect(changes()).toBe(1);
  });

  it('does not enrol once enrolment has been closed, even mid-handshake', async () => {
    const { devices, store } = setup();
    store.roster = withEnrolmentMode(store.roster, 'closed');
    const p = phone();
    await devices.enrol(p, 'pairing');
    expect(await devices.check(p.x25519)).toEqual({ standing: 'unknown', enrolment: 'closed' });
  });

  it('enrols with a pairing code but not the token while enrolment is off', async () => {
    const { devices } = setup(withEnrolmentMode(EMPTY_ROSTER, 'off'));
    const byToken = phone();
    const paired = phone();
    await devices.enrol(byToken, 'token');
    await devices.enrol(paired, 'pairing');
    expect((await devices.check(byToken.x25519)).standing).toBe('unknown');
    expect(await devices.check(paired.x25519)).toEqual({ standing: 'enrolled', enrolment: 'off' });
  });

  it('admits an enrolment only with a proof of the token over this nonce', async () => {
    const { devices } = setup();
    const p = phone();
    const claim = { account, nonce: 'n1', device: p.ed25519 };
    expect(await devices.admitsEnrolment({ device: p.ed25519, nonce: 'n1', proof: enrolProof(key, claim) })).toEqual(ADMITTED);
    expect(await devices.admitsEnrolment({ device: p.ed25519, nonce: 'n2', proof: enrolProof(key, claim) })).toEqual(
      refused('enrolment proof invalid'),
    );
    const wrong = enrolProof(enrolKey('other token', account), claim);
    expect(await devices.admitsEnrolment({ device: p.ed25519, nonce: 'n1', proof: wrong })).toEqual(refused('enrolment proof invalid'));
  });

  it('names a failed proof by the credential the phone says it used, for the log', async () => {
    const { devices } = setup();
    const p = phone();
    const claim = { account, nonce: 'n1', device: p.ed25519 };
    const wrong = enrolProof(enrolKey('other token', account), claim);
    const enrol = { device: p.ed25519, nonce: 'n1', proof: wrong };
    expect(await devices.admitsEnrolment({ ...enrol, cred: 'token' })).toEqual({
      admitted: false,
      reason: 'enrolment proof invalid',
      detail: 'its token proof did not verify (a wrong token)',
    });
    expect(await devices.admitsEnrolment({ ...enrol, cred: 'pairing' })).toEqual({
      admitted: false,
      reason: 'enrolment proof invalid',
      detail: 'its pairing code is unknown (not one this agent issued in the last day)',
    });
    expect(await devices.admitsEnrolment(enrol)).toEqual({
      admitted: false,
      reason: 'enrolment proof invalid',
      detail: 'its proof matched neither the token nor a pairing code from the last day',
    });
  });

  it('admits no enrolment while enrolment is closed or for a revoked key', async () => {
    const p = phone();
    const proof = (device: string) => enrolProof(key, { account, nonce: 'n', device });
    const closed = setup({ ...EMPTY_ROSTER, enrolment: false }).devices;
    expect(await closed.admitsEnrolment({ device: p.ed25519, nonce: 'n', proof: proof(p.ed25519) })).toEqual({
      admitted: false,
      reason: 'enrolment closed',
      detail: 'enrolment is closed',
    });
    const { devices, store } = setup();
    await devices.enrol(p, 'token');
    store.roster = revokeDevice(store.roster, store.roster.devices[0]!.id, new Date(0)).roster;
    expect(await devices.admitsEnrolment({ device: p.ed25519, nonce: 'n', proof: proof(p.ed25519) })).toEqual({
      admitted: false,
      reason: 'device revoked',
      detail: 'the device is revoked',
    });
  });
});

describe('RosterDevices pairing', () => {
  // Every `auth` from an unknown device with a pairing-shaped token asks to spend it: a stream of
  // made-up ones must neither rewrite the file nor hold its lock, which `perch pair` needs.
  it('does not touch the pairing file for a secret it never issued', async () => {
    const { devices, pairings } = setup();
    expect(await devices.redeemPairing('u'.repeat(43), 'phone')).toEqual({ redeemed: false });
    expect(await devices.burnPairing('u'.repeat(43), 'phone')).toBe(false);
    expect(pairings.updates).toBe(0);
  });

  it('spends a secret it issued', async () => {
    const { devices, pairings } = setup();
    expect(await devices.redeemPairing(SECRET, 'phone')).toEqual({ redeemed: true, fresh: true });
    expect(pairings.updates).toBe(1);
  });

  it('admits an enrolment proven with a live pairing secret, without spending it', async () => {
    const { devices, pairings } = setup();
    const p = phone();
    const claim = { account, nonce: 'n1', device: p.ed25519 };
    expect(await devices.admitsEnrolment({ device: p.ed25519, nonce: 'n1', proof: enrolProof(enrolKey(SECRET, account), claim) })).toEqual(ADMITTED);
    expect(pairings.list).toEqual(addPairing([], SECRET, new Date(0)));
  });

  const pairingProof = (p: { ed25519: string }) =>
    enrolProof(enrolKey(SECRET, account), { account, nonce: 'n1', device: p.ed25519 });

  it('says a pairing code has expired, and how long ago', async () => {
    const { devices, at } = setup();
    const p = phone();
    at(PAIRING_TTL_MS + 49_000);
    expect(await devices.admitsEnrolment({ device: p.ed25519, nonce: 'n1', proof: pairingProof(p), cred: 'pairing' })).toEqual({
      admitted: false,
      reason: 'pairing code expired',
      detail: 'its pairing code expired 49 s ago',
    });
  });

  it('says a pairing code was already used', async () => {
    const { devices, pairings } = setup();
    const p = phone();
    pairings.list = redeemPairing(pairings.list, SECRET, new Date(0), 'phone').list;
    expect(await devices.admitsEnrolment({ device: p.ed25519, nonce: 'n1', proof: pairingProof(p), cred: 'pairing' })).toEqual({
      admitted: false,
      reason: 'pairing code used',
      detail: 'its pairing code was already used',
    });
  });

  it('cannot tell a code it has forgotten from one it never issued', async () => {
    const { devices, pairings } = setup();
    const p = phone();
    pairings.list = [];
    expect(await devices.admitsEnrolment({ device: p.ed25519, nonce: 'n1', proof: pairingProof(p), cred: 'pairing' })).toEqual(
      refused('enrolment proof invalid'),
    );
  });

  it('redeems a secret once, for one device, then says it is used', async () => {
    const { devices } = setup();
    expect(await devices.redeemPairing(SECRET, 'phone')).toEqual({ redeemed: true, fresh: true });
    expect(await devices.redeemPairing(SECRET, 'phone')).toEqual({ redeemed: true, fresh: false });
    expect(await devices.redeemPairing(SECRET, 'tablet')).toEqual({ redeemed: false, reason: 'pairing code used' });
  });

  it('says an expired secret is expired when it is redeemed, and knows nothing of an unknown one', async () => {
    const { devices, at } = setup();
    at(PAIRING_TTL_MS);
    expect(await devices.redeemPairing(SECRET, 'phone')).toEqual({ redeemed: false, reason: 'pairing code expired' });
    expect(await devices.redeemPairing('u'.repeat(43), 'phone')).toEqual({ redeemed: false });
  });

  it('admits a pairing proof but refuses the token while enrolment is off', async () => {
    const { devices } = setup(withEnrolmentMode(EMPTY_ROSTER, 'off'));
    const p = phone();
    const claim = { account, nonce: 'n1', device: p.ed25519 };
    expect(await devices.admitsEnrolment({ device: p.ed25519, nonce: 'n1', proof: enrolProof(key, claim), cred: 'token' })).toEqual({
      admitted: false,
      reason: 'enrolment off',
      detail: 'token enrolment is off (only a pairing code enrols)',
    });
    expect(await devices.admitsEnrolment({ device: p.ed25519, nonce: 'n1', proof: pairingProof(p), cred: 'pairing' })).toEqual(ADMITTED);
    expect(await devices.redeemPairing(SECRET, 'phone')).toEqual({ redeemed: true, fresh: true });
  });

  it('redeems nothing while enrolment is closed, and leaves the secret for later', async () => {
    const { devices, pairings } = setup({ ...EMPTY_ROSTER, enrolment: false });
    expect(await devices.redeemPairing(SECRET, 'phone')).toEqual({ redeemed: false, reason: 'enrolment closed' });
    expect(pairings.list).toEqual(addPairing([], SECRET, new Date(0)));
  });

  // An enrolled device needs no code, but one it presents must not stay live for another.
  it('burns a live secret an enrolled device presents, whatever enrolment is set to', async () => {
    const { devices, store } = setup({ ...EMPTY_ROSTER, enrolment: false });
    expect(await devices.burnPairing(SECRET, 'tablet')).toBe(true);
    expect(await devices.burnPairing(SECRET, 'tablet')).toBe(false);
    store.roster = { ...store.roster, enrolment: true };
    expect(await devices.redeemPairing(SECRET, 'phone')).toEqual({ redeemed: false, reason: 'pairing code used' });
  });
});

describe('RosterMonitor', () => {
  it('reports a change made behind its back, not the first read', async () => {
    const store = new MemoryDeviceStore();
    const seen: DeviceRoster[] = [];
    const monitor = new RosterMonitor(store, (r) => seen.push(r));
    await monitor.poll();
    await monitor.poll();
    expect(seen).toEqual([]);
    store.roster = { ...EMPTY_ROSTER, enrolment: false };
    await monitor.poll();
    expect(seen).toEqual([store.roster]);
  });

  it('skips an unreadable roster instead of throwing', async () => {
    const store = new MemoryDeviceStore();
    store.read = () => Promise.reject(new Error('malformed'));
    await expect(new RosterMonitor(store, () => undefined).poll()).resolves.toBeUndefined();
  });
});
