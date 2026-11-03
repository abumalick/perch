import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMessageLog } from './file-message-log';
import type { MessageLogEntry } from '../ports/message-log-port';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perch-msglog-'));
  file = join(dir, 'nested', 'messages.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry: MessageLogEntry = {
  at: Date.UTC(2026, 10, 3, 12),
  from: 'perch-child-1',
  to: 'perch-orch-1',
  relation: 'child',
  cli: 'claude',
  outcome: 'delivered',
  bytes: 42,
};

describe('FileMessageLog', () => {
  it('appends one JSON line per entry and creates the directory', async () => {
    const log = new FileMessageLog(file, 1024);
    await log.append(entry);
    await log.append({ ...entry, outcome: 'refused', reason: 'empty message', cli: null });
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([entry, { ...entry, outcome: 'refused', reason: 'empty message', cli: null }]);
  });

  it('moves a file past its cap to .1 and starts a new one', async () => {
    const log = new FileMessageLog(file, 10);
    await log.append(entry);
    await log.append({ ...entry, to: 'perch-peer-2' });
    const current = (await readFile(file, 'utf8')).trim().split('\n');
    const previous = (await readFile(`${file}.1`, 'utf8')).trim().split('\n');
    expect(current.map((l) => JSON.parse(l).to)).toEqual(['perch-peer-2']);
    expect(previous.map((l) => JSON.parse(l).to)).toEqual(['perch-orch-1']);
  });
});
