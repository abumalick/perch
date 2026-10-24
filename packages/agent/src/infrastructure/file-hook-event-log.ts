import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HookEventEntry, HookEventLogPort } from '../ports/hook-event-log-port';

// Appends one JSON line per hook event (default ~/.perch/hook-events.jsonl), stamped with the
// receive time. Every tool call is an event, so the file is bounded: past `maxBytes` it moves to
// `<file>.1`, replacing the previous one. The cap is large because a stuck workspace is usually
// looked into days later. Two appends racing at the boundary can both rename, and the loser's
// event is lost: acceptable for a best-effort log, so the caller just drops the error.
export class FileHookEventLog implements HookEventLogPort {
  constructor(
    private readonly filePath: string,
    private readonly maxBytes = 50 * 1024 * 1024,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async append(entry: HookEventEntry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const size = await stat(this.filePath).then(
      (s) => s.size,
      () => 0,
    );
    if (size > this.maxBytes) await rename(this.filePath, `${this.filePath}.1`);
    const line = JSON.stringify({ ts: new Date(this.now()).toISOString(), ...entry }) + '\n';
    await appendFile(this.filePath, line, 'utf8');
  }
}
