import { describe, expect, it, vi } from 'vitest';
import { DiskReadLimiter, limitedDevices } from './disk-read-limiter';
import { EMPTY_ROSTER, type DeviceRoster } from './device-roster';
import { DeviceGateBusy, type DeviceGate } from '../ports/device-gate-port';

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('DiskReadLimiter', () => {
  it('refuses a fifth read while four are running, without calling it', async () => {
    const c = clock();
    const limiter = new DiskReadLimiter(c.now);
    const pending = Array.from({ length: 4 }, () => deferred<number>());
    const running = pending.map((d) => limiter.run(() => d.promise));
    const fifth = vi.fn(async () => 5);
    expect(await limiter.run(fifth)).toBe('limited');
    expect(fifth).not.toHaveBeenCalled();
    pending.forEach((d, i) => d.resolve(i));
    expect(await Promise.all(running)).toEqual([0, 1, 2, 3]);
    expect(await limiter.run(fifth)).toBe(5);
  });

  it('refuses an eleventh read in a minute, then reads again', async () => {
    const c = clock();
    const limiter = new DiskReadLimiter(c.now);
    for (let i = 0; i < 10; i++) expect(await limiter.run(async () => i)).toBe(i);
    const read = vi.fn(async () => 'x');
    expect(await limiter.run(read)).toBe('limited');
    expect(read).not.toHaveBeenCalled();
    c.advance(60_000);
    expect(await limiter.run(read)).toBe('x');
  });

  it('frees its slot when a read fails', async () => {
    const c = clock();
    const limiter = new DiskReadLimiter(c.now, 1);
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await limiter.run(async () => 1)).toBe(1);
  });
});

function fakeDevices() {
  const devices: DeviceGate & { checks: number; redeems: number } = {
    checks: 0,
    redeems: 0,
    async check() {
      devices.checks++;
      return { standing: 'unknown', enrolment: 'on' };
    },
    async enrol() {
      return true;
    },
    async redeemPairing() {
      devices.redeems++;
      return { redeemed: true, fresh: true };
    },
    async burnPairing() {
      return true;
    },
  };
  return devices;
}

const device = (x25519: string) => ({ id: x25519, x25519, ed25519: `ed-${x25519}`, name: x25519, enrolledAt: new Date(0).toISOString() });

describe('limitedDevices', () => {
  it('answers an enrolled key from the last roster read, with no read of its own', async () => {
    const inner = fakeDevices();
    const roster: DeviceRoster = { ...EMPTY_ROSTER, tokenEnrolment: false, devices: [device('phone')] };
    const limiter = new DiskReadLimiter(clock().now, 0, 0);
    const devices = limitedDevices(inner, limiter, () => roster);
    expect(await devices.check('phone')).toEqual({ standing: 'enrolled', enrolment: 'off' });
    expect(inner.checks).toBe(0);
  });

  it('reads the roster for any other key, through the limiter, and fails a limited check', async () => {
    const inner = fakeDevices();
    const limiter = new DiskReadLimiter(clock().now, 4, 1);
    const devices = limitedDevices(inner, limiter, () => null);
    expect(await devices.check('stranger')).toEqual({ standing: 'unknown', enrolment: 'on' });
    await expect(devices.check('stranger')).rejects.toBeInstanceOf(DeviceGateBusy);
    expect(inner.checks).toBe(1);
  });

  it('spends a pairing secret through the limiter, and fails a limited one without reading', async () => {
    const inner = fakeDevices();
    const limiter = new DiskReadLimiter(clock().now, 4, 1);
    const devices = limitedDevices(inner, limiter, () => null);
    expect(await devices.redeemPairing('s', 'k')).toEqual({ redeemed: true, fresh: true });
    await expect(devices.redeemPairing('s', 'k')).rejects.toBeInstanceOf(DeviceGateBusy);
    expect(inner.redeems).toBe(1);
  });
});
