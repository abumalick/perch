import { describe, it, expect } from 'vitest';
import { childEnv } from './child-env';

describe('childEnv', () => {
  it('drops every PERCH_ variable and keeps the rest', () => {
    const env = childEnv({
      PERCH_TOKEN: 'secret',
      PERCH_JOIN_KEY: 'join',
      PERCH_ADMIN_KEY: 'admin',
      PERCH_RELAY_URLS: 'wss://relay.example',
      HOME: '/home/u',
      PATH: '/bin',
      LANG: 'C.UTF-8',
    });
    expect(env).toEqual({ HOME: '/home/u', PATH: '/bin', LANG: 'C.UTF-8' });
  });

  it('does not change the environment it is given', () => {
    const source = { PERCH_TOKEN: 'secret', HOME: '/home/u' };
    childEnv(source);
    expect(source.PERCH_TOKEN).toBe('secret');
  });
});
