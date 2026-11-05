import { describe, expect, it } from 'vitest';
import { addressHost, normalizeAddress, parseAddressLines } from './machine-addresses';

describe('normalizeAddress', () => {
  it('spells the root path one way, so two spellings of an address match', () => {
    expect(normalizeAddress('wss://dev.example.ts.net:10000')).toBe('wss://dev.example.ts.net:10000/');
    expect(normalizeAddress(' wss://dev.example.ts.net:10000/ ')).toBe('wss://dev.example.ts.net:10000/');
    expect(normalizeAddress('wss://DEV.example.ts.net/abu')).toBe('wss://dev.example.ts.net/abu');
  });

  it('refuses what a phone may not dial', () => {
    for (const bad of ['', 'https://dev.example/', 'ws://dev.example/', 'wss://dev.example/a/b', 'not a url']) {
      expect(normalizeAddress(bad)).toBeNull();
    }
    expect(normalizeAddress('ws://127.0.0.1:4000')).toBe('ws://127.0.0.1:4000/');
  });
});

describe('parseAddressLines', () => {
  it('reads one address per line, in order, skipping blank lines and repeats', () => {
    expect(parseAddressLines('wss://a.example:10000/abu\n\n  wss://b.example/\nwss://a.example:10000/abu\n')).toEqual([
      'wss://a.example:10000/abu',
      'wss://b.example/',
    ]);
  });

  it('refuses none, more than four, or any invalid line', () => {
    expect(parseAddressLines('')).toBeNull();
    expect(parseAddressLines('\n  \n')).toBeNull();
    expect(parseAddressLines('wss://a.example/\nhttps://b.example/')).toBeNull();
    expect(parseAddressLines(['a', 'b', 'c', 'd', 'e'].map((h) => `wss://${h}.example/`).join('\n'))).toBeNull();
  });
});

describe('addressHost', () => {
  it('is the host and port, or the text itself when it is no URL', () => {
    expect(addressHost('wss://dev.example.ts.net:10000/abu')).toBe('dev.example.ts.net:10000');
    expect(addressHost('nonsense')).toBe('nonsense');
  });
});
