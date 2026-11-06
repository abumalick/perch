import { describe, expect, it } from 'vitest';
import { deviceFingerprint, generateDeviceKeys } from '@tarfa/secure-channel';
import {
  EMPTY_ROSTER,
  enrolDevice,
  enrolmentMode,
  forgetDevice,
  withEnrolmentMode,
  revokeDevice,
  standingOf,
} from './device-roster';

const AT = new Date('2026-09-24T10:00:00Z');

function phone(name = 'phone') {
  const keys = generateDeviceKeys();
  return { x25519: keys.x25519.publicKey, ed25519: keys.ed25519.publicKey, name };
}

describe('device roster', () => {
  it('enrols an unknown key once, under its fingerprint', () => {
    const p = phone();
    const roster = enrolDevice(EMPTY_ROSTER, p, AT);
    expect(standingOf(roster, p.x25519)).toBe('enrolled');
    expect(roster.devices[0]).toEqual({ id: deviceFingerprint(p.x25519), ...p, enrolledAt: AT.toISOString() });
    expect(enrolDevice(roster, p, AT)).toBe(roster);
  });

  it('keeps a revoked key revoked, even if it asks to enrol again', () => {
    const p = phone();
    const enrolled = enrolDevice(EMPTY_ROSTER, p, AT);
    const { roster, device } = revokeDevice(enrolled, enrolled.devices[0]!.id.slice(0, 4), AT);
    expect(device?.x25519).toBe(p.x25519);
    expect(standingOf(roster, p.x25519)).toBe('revoked');
    expect(enrolDevice(roster, p, AT)).toBe(roster);
  });

  it('forgets a device from either list, so it can enrol again', () => {
    const p = phone();
    const enrolled = enrolDevice(EMPTY_ROSTER, p, AT);
    const revoked = revokeDevice(enrolled, enrolled.devices[0]!.id, AT).roster;
    const { roster } = forgetDevice(revoked, enrolled.devices[0]!.id);
    expect(standingOf(roster, p.x25519)).toBe('unknown');
    expect(standingOf(enrolDevice(roster, p, AT), p.x25519)).toBe('enrolled');
  });

  it('finds nothing for an unknown or ambiguous id', () => {
    const roster = enrolDevice(enrolDevice(EMPTY_ROSTER, phone(), AT), phone(), AT);
    expect(revokeDevice(roster, 'zzzz', AT).device).toBeNull();
    expect(revokeDevice(roster, '', AT).device).toBeNull();
  });

  // Ids are 48 bits: someone holding the token can search out two keys that share one in minutes.
  describe('two keys under one id', () => {
    const twins = () => {
      const a = phone('a');
      const b = phone('b');
      const id = deviceFingerprint(a.x25519);
      const roster = {
        ...EMPTY_ROSTER,
        devices: [
          { id, ...a, enrolledAt: AT.toISOString() },
          { id, ...b, enrolledAt: AT.toISOString() },
        ],
      };
      return { a, b, id, roster };
    };

    it('revokes and forgets each by its full key', () => {
      const { a, b, roster } = twins();
      expect(revokeDevice(roster, roster.devices[0]!.id, AT).device).toBeNull();
      const revoked = revokeDevice(roster, b.x25519, AT);
      expect(revoked.device?.x25519).toBe(b.x25519);
      expect(standingOf(revoked.roster, b.x25519)).toBe('revoked');
      expect(standingOf(revoked.roster, a.x25519)).toBe('enrolled');
      const forgotten = forgetDevice(revoked.roster, b.x25519);
      expect(standingOf(forgotten.roster, b.x25519)).toBe('unknown');
      expect(standingOf(forgotten.roster, a.x25519)).toBe('enrolled');
    });

    it('does not enrol a key whose id is already taken, enrolled or revoked', () => {
      const p = phone();
      const taken = { id: deviceFingerprint(p.x25519), ...phone('other'), enrolledAt: AT.toISOString() };
      const withDevice = { ...EMPTY_ROSTER, devices: [taken] };
      expect(enrolDevice(withDevice, p, AT)).toBe(withDevice);
      const withRevoked = { ...EMPTY_ROSTER, revoked: [{ ...taken, revokedAt: AT.toISOString() }] };
      expect(enrolDevice(withRevoked, p, AT)).toBe(withRevoked);
    });
  });

  it('reads the enrolment mode, keeping a roster from before the modes closed if it was off', () => {
    expect(enrolmentMode(EMPTY_ROSTER)).toBe('on');
    expect(enrolmentMode({ ...EMPTY_ROSTER, enrolment: false })).toBe('closed');
    for (const mode of ['on', 'off', 'closed'] as const) {
      expect(enrolmentMode(withEnrolmentMode(EMPTY_ROSTER, mode))).toBe(mode);
    }
  });

  it('keeps `enrolment` meaning "any enrolment at all", so an agent from before the modes reads it safely', () => {
    expect(withEnrolmentMode(EMPTY_ROSTER, 'off')).toMatchObject({ enrolment: true, tokenEnrolment: false });
    expect(withEnrolmentMode(EMPTY_ROSTER, 'closed')).toMatchObject({ enrolment: false });
    expect(withEnrolmentMode(withEnrolmentMode(EMPTY_ROSTER, 'off'), 'on')).toMatchObject({ enrolment: true, tokenEnrolment: true });
  });
});
