import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { EMPTY_ROSTER, type DeviceRoster } from '../application/device-roster';
import type { DeviceStorePort } from '../ports/device-store-port';
import { withFileLock, writeFileAtomic } from './file-lock';

const key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const device = z.object({ id: z.string(), x25519: key, ed25519: key, name: z.string(), enrolledAt: z.string() });
const rosterSchema = z.object({
  enrolment: z.boolean(),
  tokenEnrolment: z.boolean().optional(),
  devices: z.array(device),
  revoked: z.array(device.extend({ revokedAt: z.string() })),
});

// ~/.perch/devices.json. Unlike the other ~/.perch files, a malformed one is an error, never an
// empty list: an empty roster would silently re-open enrolment and forget every revocation.
// Updates hold a lock file, since the agent (enrolling) and `perch devices` (revoking) write it
// from different processes, and a lost revocation must not pass silently.
export class FileDeviceStore implements DeviceStorePort {
  private readonly staleLockMs: number;

  constructor(
    private readonly filePath: string,
    options: { staleLockMs?: number } = {},
  ) {
    this.staleLockMs = options.staleLockMs ?? 10_000;
  }

  async read(): Promise<DeviceRoster> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_ROSTER;
      throw err;
    }
    const parsed = rosterSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`device roster ${this.filePath} is malformed; fix or move it aside`);
    return parsed.data;
  }

  async update(change: (roster: DeviceRoster) => DeviceRoster): Promise<DeviceRoster> {
    return withFileLock(this.filePath, this.staleLockMs, async () => {
      const next = change(await this.read());
      await writeFileAtomic(this.filePath, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }
}
