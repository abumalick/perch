import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Pairing } from '../application/pairing';
import type { PairingStorePort } from '../ports/pairing-store-port';
import { withFileLock, writeFileAtomic } from './file-lock';

const schema = z.array(z.object({ secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.string(), usedAt: z.string().optional(), usedBy: z.string().optional() }));

// ~/.perch/pairing.json. Missing or malformed reads as no secrets, which admits nobody.
export class FilePairingStore implements PairingStorePort {
  constructor(
    private readonly filePath: string,
    private readonly staleLockMs = 10_000,
  ) {}

  async read(): Promise<Pairing[]> {
    try {
      const parsed = schema.safeParse(JSON.parse(await readFile(this.filePath, 'utf8')));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  async update(change: (list: Pairing[]) => Pairing[]): Promise<Pairing[]> {
    return withFileLock(this.filePath, this.staleLockMs, async () => {
      const current = await this.read();
      const next = change(current);
      if (JSON.stringify(next) !== JSON.stringify(current)) await writeFileAtomic(this.filePath, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }
}
