import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MessageLog, MessageLogEntry } from '../ports/message-log-port';

// Appends one JSON line per `perch send` (default ~/.perch/messages.jsonl), delivered or refused,
// never with its body. Bounded like FileHookEventLog: past `maxBytes` it moves to `<file>.1`.
export class FileMessageLog implements MessageLog {
  constructor(
    private readonly filePath: string,
    private readonly maxBytes = 50 * 1024 * 1024,
  ) {}

  async append(entry: MessageLogEntry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const size = await stat(this.filePath).then(
      (s) => s.size,
      () => 0,
    );
    if (size > this.maxBytes) await rename(this.filePath, `${this.filePath}.1`);
    await appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
  }
}
