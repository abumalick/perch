import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileHookEventLog } from './file-hook-event-log';
import type { HookEventEntry } from '../ports/hook-event-log-port';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perch-hooklog-'));
  file = join(dir, 'nested', 'hook-events.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const marks = { deferred: false, messagedLast: false, questionPending: false };
const entry: HookEventEntry = {
  workspace: 'perch-aa',
  event: 'Stop',
  reason: 'stop',
  before: { status: 'working', ...marks },
  after: { status: 'needs-feedback', ...marks },
};

describe('FileHookEventLog', () => {
  it('appends one timestamped JSON line per entry and creates the directory', async () => {
    const log = new FileHookEventLog(file, 1024, () => Date.UTC(2026, 9, 24, 12));
    await log.append(entry);
    await log.append({ ...entry, event: 'UserPromptSubmit', reason: 'prompt' });
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ ts: '2026-10-24T12:00:00.000Z', ...entry });
    expect(lines[1]).toMatchObject({ event: 'UserPromptSubmit', reason: 'prompt' });
  });

  it('moves a file past its cap to .1 and starts a new one', async () => {
    const log = new FileHookEventLog(file, 10);
    await log.append(entry);
    await log.append({ ...entry, workspace: 'perch-bb' });
    const current = (await readFile(file, 'utf8')).trim().split('\n');
    const previous = (await readFile(`${file}.1`, 'utf8')).trim().split('\n');
    expect(current.map((l) => JSON.parse(l).workspace)).toEqual(['perch-bb']);
    expect(previous.map((l) => JSON.parse(l).workspace)).toEqual(['perch-aa']);
  });
});
