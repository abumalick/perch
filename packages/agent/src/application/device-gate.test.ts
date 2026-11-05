import { describe, expect, it } from 'vitest';
import { generateDeviceKeys } from '@tarfa/secure-channel';
import type { DeviceStorePort } from '../ports/device-store-port';
import type { PairingStorePort } from '../ports/pairing-store-port';
import { PAIRING_TTL_MS, addPairing, redeemPairing, type Pairing } from './pairing';
import { EMPTY_ROSTER, withEnrolmentMode, type DeviceRoster } from './device-roster';
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

const SECRET = 's'.repeat(43);

function setup(roster?: DeviceRoster) {
  const store = new MemoryDeviceStore(roster);
  const pairings = new MemoryPairingStore(addPairing([], SECRET, new Date(0)));
  let changes = 0;
  let now = new Date(0);
  const devices = new RosterDevices({ store, pairings, now: () => now, onChange: () => (changes += 1) });
  return { store, pairings, devices, changes: () => changes, at: (ms: number) => (now = new Date(ms)) };
}

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
});

describe('RosterDevices pairing', () => {
  // Every `auth` from an unknown device with a pairing-shaped token asks to spend it: a stream of
  // made-up ones must neither rewrite the file nor hold its lock, which `tarfa pair` needs.
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

  it('redeems a pairing code while enrolment is off', async () => {
    const { devices } = setup(withEnrolmentMode(EMPTY_ROSTER, 'off'));
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

  it('hands every successful read, the first included, to its reader', async () => {
    const store = new MemoryDeviceStore();
    const read: DeviceRoster[] = [];
    const monitor = new RosterMonitor(store, () => undefined, (r) => read.push(r));
    await monitor.poll();
    await monitor.poll();
    expect(read).toEqual([store.roster, store.roster]);
  });

  it('skips an unreadable roster instead of throwing', async () => {
    const store = new MemoryDeviceStore();
    store.read = () => Promise.reject(new Error('malformed'));
    await expect(new RosterMonitor(store, () => undefined).poll()).resolves.toBeUndefined();
  });
});
