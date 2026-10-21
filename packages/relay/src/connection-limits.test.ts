import { describe, expect, it } from 'vitest';
import { ConnectionLimiter, clientAddress } from './connection-limits.ts';

const counted = (peer: string | undefined, forwarded?: string) => clientAddress(peer, forwarded).counted;

describe('clientAddress', () => {
  it('takes the forwarded address only from a loopback peer, where a local proxy connects from', () => {
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.3.4.5']) {
      expect(clientAddress(peer, '203.0.113.9')).toEqual({ counted: '203.0.113.9', label: '203.0.113.9' });
    }
  });

  it('ignores a forwarded address from any other peer, which could have written it itself', () => {
    expect(counted('192.168.1.20', '203.0.113.9')).toBe('192.168.1.20');
    expect(counted('100.64.1.2', '203.0.113.9')).toBe('100.64.1.2');
    expect(counted('::ffff:10.0.0.1', '203.0.113.9')).toBe('::ffff:10.0.0.1');
  });

  it('takes the last entry of a list, the one the proxy itself appended', () => {
    expect(counted('127.0.0.1', '198.51.100.1, 203.0.113.9')).toBe('203.0.113.9');
    expect(counted('127.0.0.1', '198.51.100.1,203.0.113.9 ')).toBe('203.0.113.9');
    expect(counted('127.0.0.1', '203.0.113.9, junk')).toBeNull();
  });

  // Every client behind a local proxy shares its loopback address, so a cap keyed on it would
  // let any few connections lock out everyone else, the owner included.
  it('counts a loopback peer without a usable forwarded address against the host only', () => {
    expect(clientAddress('127.0.0.1', undefined)).toEqual({ counted: null, label: '127.0.0.1' });
    expect(counted('::1', undefined)).toBeNull();
    expect(counted('127.0.0.1', '')).toBeNull();
    expect(counted('127.0.0.1', 'not an address, with junk')).toBeNull();
  });

  it('counts any other peer by its own address', () => {
    expect(clientAddress('192.168.1.20', undefined)).toEqual({ counted: '192.168.1.20', label: '192.168.1.20' });
    expect(clientAddress(undefined, '203.0.113.9')).toEqual({ counted: 'unknown', label: 'unknown' });
  });

  it('counts an IPv6 client by its /64, which one subscriber holds whole', () => {
    expect(counted('127.0.0.1', '2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(counted('127.0.0.1', '2001:db8:0:0:ffff:1:2:3')).toBe('2001:db8:0:0::/64');
    expect(counted('127.0.0.1', '2001:DB8:a:b::9')).toBe('2001:db8:a:b::/64');
    expect(counted('127.0.0.1', '::ffff:203.0.113.4')).toBe('203.0.113.4');
    expect(counted('::1', '2001:db8:1::')).toBe('2001:db8:1:0::/64');
  });
});

describe('ConnectionLimiter', () => {
  it('refuses past the per-address cap and admits again once one is released', () => {
    const limiter = new ConnectionLimiter({ maxConnections: 10, maxPerAddress: 2 });
    const a = limiter.acquire('a');
    const b = limiter.acquire('a');
    expect(a && b).toBeTruthy();
    expect(limiter.acquire('a')).toBeNull();
    expect(limiter.acquire('other')).not.toBeNull();
    a!.release();
    expect(limiter.acquire('a')).not.toBeNull();
  });

  it('refuses past the global cap, whatever the address', () => {
    const limiter = new ConnectionLimiter({ maxConnections: 2, maxPerAddress: 5 });
    expect(limiter.acquire('a')).not.toBeNull();
    expect(limiter.acquire('b')).not.toBeNull();
    expect(limiter.acquire('c')).toBeNull();
    expect(limiter.size).toBe(2);
  });

  it('releases a slot once, however often release is called', () => {
    const limiter = new ConnectionLimiter({ maxConnections: 5, maxPerAddress: 1 });
    const slot = limiter.acquire('a')!;
    slot.release();
    slot.release();
    expect(limiter.size).toBe(0);
    expect(limiter.acquire('a')).not.toBeNull();
    expect(limiter.acquire('a')).toBeNull();
  });

  it('counts a slot without an address against the host only', () => {
    const limiter = new ConnectionLimiter({ maxConnections: 3, maxPerAddress: 1 });
    const agent = limiter.acquire(null)!;
    expect(limiter.acquire(null)).not.toBeNull();
    expect(limiter.acquire('home')).not.toBeNull();
    expect(limiter.acquire(null)).toBeNull();
    agent.release();
    expect(limiter.size).toBe(2);
    expect(limiter.acquire('home')).toBeNull();
  });

  // A flood of phones must not lock the agent out of its own relay: its control socket and
  // dial-backs keep a few slots of their own past the host cap.
  it('keeps the reserved slots for the agent alone', () => {
    const limiter = new ConnectionLimiter({ maxConnections: 2, maxPerAddress: 5, agentReserve: 1 });
    expect(limiter.acquire('a')).not.toBeNull();
    expect(limiter.acquire(null)).not.toBeNull();
    expect(limiter.acquire('c')).toBeNull();
    expect(limiter.acquire(null)).toBeNull();
    const agent = limiter.acquireAgent();
    expect(agent).not.toBeNull();
    expect(limiter.acquireAgent()).toBeNull();
    agent!.release();
    expect(limiter.acquireAgent()).not.toBeNull();
  });
});
