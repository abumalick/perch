import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { PathResolver } from '../ports/path-resolver';

export const systemClock: Clock = {
  now: () => Date.now(),
};

export const systemPathResolver: PathResolver = (path) => resolve(path);

// Ids of the old `perch-<hex>` shape; tests use it where the id's value does not matter.
export class RandomIdGenerator implements IdGenerator {
  async next(): Promise<string> {
    return `perch-${randomBytes(3).toString('hex')}`;
  }
}
