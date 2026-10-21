import { describe, it, expect } from 'vitest';
import { exposedFiles } from './private-files';

describe('exposedFiles', () => {
  it('names each file another user could read or change, with the fix', () => {
    expect(
      exposedFiles([
        { path: '/h/.perch/relay-key.json', mode: 0o100600 },
        { path: '/h/.perch/devices.json', mode: 0o100644 },
        { path: '/h/.perch/token', mode: 0o100620 },
      ]),
    ).toEqual([
      '/h/.perch/devices.json is readable or writable by other users (mode 644): run `chmod 600 /h/.perch/devices.json`',
      '/h/.perch/token is readable or writable by other users (mode 620): run `chmod 600 /h/.perch/token`',
    ]);
  });

  it('accepts files only their owner can use', () => {
    expect(exposedFiles([{ path: '/h/.perch/pairing.json', mode: 0o100400 }])).toEqual([]);
  });
});
