import { describe, it, expect } from 'vitest';
import { childEnv } from './child-env';

describe('childEnv', () => {
  it('drops every TARFA_ and PERCH_ variable and keeps the rest', () => {
    const env = childEnv({
      TARFA_TOKEN: 'secret',
      PERCH_TOKEN: 'legacy',
      TARFA_PHONE_ADDRESSES: 'wss://box.example.ts.net',
      HOME: '/home/u',
      PATH: '/bin',
      LANG: 'C.UTF-8',
    });
    expect(env).toEqual({ HOME: '/home/u', PATH: '/bin', LANG: 'C.UTF-8' });
  });

  it('does not change the environment it is given', () => {
    const source = { TARFA_TOKEN: 'secret', HOME: '/home/u' };
    childEnv(source);
    expect(source.TARFA_TOKEN).toBe('secret');
  });
});
