import { describe, it, expect } from 'vitest';
import { isCleartextRemote, withoutTrailingSlash } from './relay-url';

describe('withoutTrailingSlash', () => {
  it('removes every trailing slash and nothing else', () => {
    expect(withoutTrailingSlash('wss://relay.example//')).toBe('wss://relay.example');
    expect(withoutTrailingSlash('wss://relay.example/base')).toBe('wss://relay.example/base');
    expect(withoutTrailingSlash(' wss://relay.example/ ')).toBe(' wss://relay.example/ ');
  });
});

// Over ws:// the agent's signed upgrade headers and the published policy travel in the clear,
// which only loopback makes safe; the phone holds a relay to the same rule.
describe('isCleartextRemote', () => {
  it('flags ws:// to anything but loopback', () => {
    expect(isCleartextRemote('ws://relay.example.com')).toBe(true);
    expect(isCleartextRemote('ws://100.64.0.1:8450')).toBe(true);
    for (const url of ['ws://127.0.0.1:8450', 'ws://localhost:8450', 'ws://[::1]:8450', 'wss://relay.example.com']) {
      expect(isCleartextRemote(url)).toBe(false);
    }
  });
});
