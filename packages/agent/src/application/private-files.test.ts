import { describe, it, expect } from 'vitest';
import { exposedFiles } from './private-files';

describe('exposedFiles', () => {
  it('names each file another user could read or change, with the fix', () => {
    expect(
      exposedFiles([
        { path: '/h/.tarfa/agent-key.json', mode: 0o100600 },
        { path: '/h/.tarfa/devices.json', mode: 0o100644 },
        { path: '/h/.tarfa/token', mode: 0o100620 },
      ]),
    ).toEqual([
      '/h/.tarfa/devices.json is readable or writable by other users (mode 644): run `chmod 600 /h/.tarfa/devices.json`',
      '/h/.tarfa/token is readable or writable by other users (mode 620): run `chmod 600 /h/.tarfa/token`',
    ]);
  });

  it('accepts files only their owner can use', () => {
    expect(exposedFiles([{ path: '/h/.tarfa/pairing.json', mode: 0o100400 }])).toEqual([]);
  });
});
