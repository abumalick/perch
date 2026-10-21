import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_ROSTER, enrolmentMode, withEnrolmentMode } from '../application/device-roster';
import { FileDeviceStore } from './file-device-store';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perch-devices-'));
  path = join(dir, 'perch', 'devices.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileDeviceStore', () => {
  it('reads a missing file as an empty roster with enrolment open', async () => {
    expect(await new FileDeviceStore(path).read()).toEqual(EMPTY_ROSTER);
  });

  it('writes a change and reads it back, private to the user', async () => {
    const store = new FileDeviceStore(path);
    await store.update((r) => ({ ...r, enrolment: false }));
    expect((await store.read()).enrolment).toBe(false);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ...EMPTY_ROSTER, enrolment: false });
  });

  it('keeps the enrolment mode, token enrolment off included', async () => {
    const store = new FileDeviceStore(path);
    await store.update((r) => withEnrolmentMode(r, 'off'));
    expect(enrolmentMode(await new FileDeviceStore(path).read())).toBe('off');
  });

  it('serialises concurrent updates, from this process or another store on the same file', async () => {
    const a = new FileDeviceStore(path);
    const b = new FileDeviceStore(path);
    const name = (i: number) => ({ id: `d${i}`, x25519: 'x'.repeat(43), ed25519: 'e'.repeat(43), name: `${i}`, enrolledAt: 't' });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).update((r) => ({ ...r, devices: [...r.devices, name(i)] }))),
    );
    expect((await a.read()).devices.map((d) => d.id).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `d${i}`).sort());
  });

  it('breaks a lock left behind by a process that died holding it', async () => {
    const store = new FileDeviceStore(path, { staleLockMs: 0 });
    await store.update((r) => r);
    await writeFile(`${path}.lock`, '');
    await store.update((r) => ({ ...r, enrolment: false }));
    expect((await store.read()).enrolment).toBe(false);
  });

  it('refuses a malformed file instead of treating it as empty', async () => {
    const store = new FileDeviceStore(path);
    await store.update((r) => r);
    await writeFile(path, '{"enrolment":true}');
    await expect(store.read()).rejects.toThrow(/malformed/);
    await expect(store.update((r) => r)).rejects.toThrow(/malformed/);
  });
});
