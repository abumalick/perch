import { describe, it, expect } from 'vitest';
import { relayHost } from './relay-host';

describe('relayHost', () => {
  it('names the relay by its host, keeping a port so two relays on one machine differ', () => {
    expect(relayHost('wss://relay.example.com/abc123')).toBe('relay.example.com');
    expect(relayHost('wss://box.example.ts.net:8451/abc123')).toBe('box.example.ts.net:8451');
  });

  it('shows an entry it cannot parse as typed', () => {
    expect(relayHost('not a url')).toBe('not a url');
  });
});
