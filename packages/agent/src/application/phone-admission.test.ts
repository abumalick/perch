import { describe, expect, it } from 'vitest';
import { PhoneAdmission, clientAddress } from './phone-admission';

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function admitted(result: ReturnType<PhoneAdmission['admit']>) {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

describe('clientAddress', () => {
  it('believes x-forwarded-for only from a loopback peer, and takes its last hop', () => {
    expect(clientAddress('127.0.0.1', '1.2.3.4, 100.64.0.9')).toBe('100.64.0.9');
    expect(clientAddress('::ffff:127.0.0.1', '100.64.0.9')).toBe('100.64.0.9');
    expect(clientAddress('::1', ' 100.64.0.9 ')).toBe('100.64.0.9');
    expect(clientAddress('100.1.1.1', '9.9.9.9')).toBe('100.1.1.1');
  });

  it('names no client for a loopback peer without the header', () => {
    expect(clientAddress('127.0.0.1', undefined)).toBeNull();
    expect(clientAddress('127.0.0.1', ' , ')).toBeNull();
  });
});

describe('PhoneAdmission', () => {
  it('refuses a ninth unauthenticated socket from one address, and takes it back once one goes', () => {
    const c = clock();
    const admission = new PhoneAdmission({ now: c.now });
    const held = Array.from({ length: 8 }, () => admitted(admission.admit('a', () => undefined)));
    expect(admission.admit('a', () => undefined)).toEqual({ ok: false, reason: 'address' });
    expect(admission.admit('b', () => undefined).ok).toBe(true);
    held[0]!.release();
    expect(admission.admit('a', () => undefined).ok).toBe(true);
  });

  it('evicts the oldest unauthenticated socket when full, never the newcomer', () => {
    const c = clock();
    const admission = new PhoneAdmission({ now: c.now });
    const evicted: number[] = [];
    for (let i = 0; i < 32; i++) admitted(admission.admit(`10.0.0.${i}`, () => evicted.push(i)));
    expect(evicted).toEqual([]);
    expect(admission.admit('10.0.1.1', () => evicted.push(32)).ok).toBe(true);
    expect(evicted).toEqual([0]);
    expect(admission.admit('10.0.1.2', () => evicted.push(33)).ok).toBe(true);
    expect(evicted).toEqual([0, 1]);
  });

  it('counts a loopback peer naming no client against the total only', () => {
    const c = clock();
    const admission = new PhoneAdmission({ now: c.now });
    const evicted: number[] = [];
    for (let i = 0; i < 40; i++) expect(admission.admit(null, () => evicted.push(i)).ok).toBe(true);
    expect(evicted).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('never counts nor evicts an authenticated session', () => {
    const c = clock();
    const admission = new PhoneAdmission({ now: c.now });
    let ownerEvicted = false;
    const owner = admitted(admission.admit('owner', () => (ownerEvicted = true)));
    owner.authenticated();
    for (let i = 0; i < 40; i++) admission.admit(`10.0.0.${i}`, () => undefined);
    expect(ownerEvicted).toBe(false);
    for (let i = 0; i < 8; i++) admitted(admission.admit('owner', () => undefined));
    // Releasing it after authentication changes nothing.
    owner.release();
    expect(admission.admit('owner', () => undefined)).toEqual({ ok: false, reason: 'address' });
  });

  it('refuses a 21st socket in a minute from one address, then admits it again', () => {
    const c = clock();
    const admission = new PhoneAdmission({ now: c.now });
    for (let i = 0; i < 20; i++) admitted(admission.admit('a', () => undefined)).release();
    expect(admission.admit('a', () => undefined)).toEqual({ ok: false, reason: 'rate' });
    expect(admission.admit('b', () => undefined).ok).toBe(true);
    c.advance(60_000);
    expect(admission.admit('a', () => undefined).ok).toBe(true);
  });

  it('frees a slot once, however often it is released', () => {
    const c = clock();
    const admission = new PhoneAdmission({ now: c.now, perAddress: 2 });
    const first = admitted(admission.admit('a', () => undefined));
    admitted(admission.admit('a', () => undefined));
    first.release();
    first.release();
    first.authenticated();
    admitted(admission.admit('a', () => undefined));
    expect(admission.admit('a', () => undefined)).toEqual({ ok: false, reason: 'address' });
  });

  it('does not evict a socket that was released in the meantime', () => {
    const c = clock();
    const admission = new PhoneAdmission({ now: c.now, total: 2 });
    const evicted: string[] = [];
    const a = admitted(admission.admit('a', () => evicted.push('a')));
    admitted(admission.admit('b', () => evicted.push('b')));
    a.release();
    admitted(admission.admit('c', () => evicted.push('c')));
    expect(evicted).toEqual([]);
    admitted(admission.admit('d', () => evicted.push('d')));
    expect(evicted).toEqual(['b']);
  });
});
