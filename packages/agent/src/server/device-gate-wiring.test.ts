import { describe, expect, it } from 'vitest';
import { b64url, generateAgentKeys } from '@perch/secure-channel';
import type { DeviceStorePort } from '../ports/device-store-port';
import type { PairingStorePort } from '../ports/pairing-store-port';
import type { Pairing } from '../application/pairing';
import { EMPTY_ROSTER, revokeDevice, type DeviceRoster } from '../application/device-roster';
import { startDeviceGate } from './device-gate-wiring';

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
  list: Pairing[] = [];
  async read() {
    return this.list;
  }
  async update(change: (l: Pairing[]) => Pairing[]) {
    this.list = change(this.list);
    return this.list;
  }
}

const device = (x25519: string) => ({ id: x25519, x25519, ed25519: `ed-${x25519}`, name: x25519, enrolledAt: new Date(0).toISOString() });

function setup(roster: DeviceRoster) {
  const keys = generateAgentKeys();
  const store = new MemoryDeviceStore(roster);
  const revokedChecks: Array<(key: string) => boolean> = [];
  const gate = startDeviceGate({
    keys,
    server: { refuseRevokedDevices: (isRevoked) => revokedChecks.push(isRevoked) },
    store,
    pairings: new MemoryPairingStore(),
    log: () => undefined,
    rosterPollMs: 60_000,
  });
  return { keys, store, gate, revokedChecks };
}

describe('startDeviceGate', () => {
  it('serves one static key, and hands every socket the same gate', () => {
    const { keys, gate } = setup(EMPTY_ROSTER);
    expect(gate.staticPrivate).toEqual(b64url.decode(keys.x25519.privateKey));
    const onAuthenticated = () => undefined;
    const a = gate.options({ onAuthenticated });
    const b = gate.options({});
    expect(a.devices).toBe(b.devices);
    expect(a.pushBudget).toBe(b.pushBudget);
    expect(a.refusalLog).toBe(b.refusalLog);
    expect(a.onAuthenticated).toBe(onAuthenticated);
    gate.stop();
  });

  it('keeps the roster it last read', async () => {
    const { store, gate } = setup({ ...EMPTY_ROSTER, devices: [device('a'), device('b')] });
    await gate.pollRoster();
    expect(gate.roster()).toEqual(store.roster);
    store.roster = revokeDevice(store.roster, 'b', new Date(0)).roster;
    await gate.pollRoster();
    expect(gate.roster()).toEqual(store.roster);
    gate.stop();
  });

  it('on a roster edit seen by the monitor, closes revoked sessions', async () => {
    const { store, gate, revokedChecks } = setup({ ...EMPTY_ROSTER, devices: [device('a')] });
    await gate.pollRoster();
    store.roster = revokeDevice(store.roster, 'a', new Date(0)).roster;
    await gate.pollRoster();
    expect(revokedChecks).toHaveLength(1);
    expect(revokedChecks[0]!('a')).toBe(true);
    expect(revokedChecks[0]!('z')).toBe(false);
    gate.stop();
  });
});
