import { describe, expect, it } from 'vitest';
import { addressKey } from './address-key.ts';

describe('addressKey', () => {
  it('keys an IPv4 address by itself', () => {
    expect(addressKey('203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('0.0.0.0')).toBe('0.0.0.0');
    expect(addressKey('255.255.255.255')).toBe('255.255.255.255');
  });

  it('keys an IPv4-mapped IPv6 address by its IPv4 address, however it is written', () => {
    expect(addressKey('::ffff:203.0.113.4')).toBe('203.0.113.4');
    expect(addressKey('::FFFF:203.0.113.4')).toBe('203.0.113.4');
    expect(addressKey('0:0:0:0:0:ffff:203.0.113.4')).toBe('203.0.113.4');
    expect(addressKey('::ffff:cb00:7104')).toBe('203.0.113.4');
  });

  it('keys an IPv6 address by its /64, compressed or expanded alike', () => {
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('2001:0db8:0000:0000:ffff:0001:0002:0003')).toBe('2001:db8:0:0::/64');
    expect(addressKey('2001:DB8:a:b::9')).toBe('2001:db8:a:b::/64');
    expect(addressKey('2001:db8:1::')).toBe('2001:db8:1:0::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
    expect(addressKey('::')).toBe('0:0:0:0::/64');
    expect(addressKey('1:2:3:4:5:6:7::')).toBe('1:2:3:4::/64');
    expect(addressKey('64:ff9b::198.51.100.7')).toBe('64:ff9b:0:0::/64');
  });

  it('drops a zone id', () => {
    expect(addressKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(addressKey('fe80::1%')).toBeNull();
  });

  it('refuses anything that is not an address', () => {
    for (const garbage of [
      '',
      'unknown',
      'junk',
      ' 203.0.113.9',
      '203.0.113',
      '203.0.113.9.1',
      '203.0.113.256',
      '203.0.113.09',
      '1.2.3.-4',
      '2001:db8::1::2',
      '2001:db8:::1',
      ':2001:db8::1',
      '2001:db8::1:',
      '1:2:3:4:5:6:7:8:9',
      '1:2:3:4:5:6:7',
      '1:2:3:4:5:6:7:8::',
      '12345::1',
      'g::1',
      '[2001:db8::1]',
      '::ffff:203.0.113',
      '1.2.3.4::',
      '203.0.113.4%eth0',
    ]) {
      expect(addressKey(garbage), garbage).toBeNull();
    }
  });
});
