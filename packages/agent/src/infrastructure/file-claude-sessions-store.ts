import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ClaudeInbox, ClaudeSessionsPort } from '../ports/claude-sessions-port';
import { parseClaudeSession } from '../application/parse-claude-session';

// Reads Claude Code's session registry (default ~/.claude/sessions), one json file per live
// session. A missing directory yields an empty map, so an agent on a machine without Claude
// Code — or a future version that moves the registry — simply shows no addresses.
//
// Read fresh on every call, deliberately: a cache would leave a newly-spawned session
// unaddressable until the agent restarted, which is exactly when the address is wanted.
export class FileClaudeSessionsStore implements ClaudeSessionsPort {
  constructor(private readonly dirPath: string) {}

  async addressesByTmuxSession(): Promise<Record<string, string>> {
    let files: string[];
    try {
      files = await readdir(this.dirPath);
    } catch {
      return {};
    }
    const addresses: Record<string, string> = {};
    await Promise.all(
      files
        // The directory also holds per-session `.key` files, which are not registry entries.
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => {
          const entry = await this.read(join(this.dirPath, f));
          if (entry) addresses[entry.tmuxSession] = entry.address;
        }),
    );
    return addresses;
  }

  async inboxOf(tmuxSession: string): Promise<ClaudeInbox | null> {
    let files: string[];
    try {
      files = await readdir(this.dirPath);
    } catch {
      return null;
    }
    for (const f of files.filter((name) => name.endsWith('.json'))) {
      const raw = await this.readJson(join(this.dirPath, f));
      if (typeof raw !== 'object' || raw === null) continue;
      const { pid, tmux, messagingSocketPath, peerProtocol } = raw as Record<string, unknown>;
      if (typeof tmux !== 'string' || tmux.split(':')[0] !== tmuxSession) continue;
      if (typeof pid !== 'number' || !isAlive(pid)) continue;
      if (typeof messagingSocketPath !== 'string' || typeof peerProtocol !== 'number') continue;
      const token = await this.peerToken(pid, messagingSocketPath);
      return { socketPath: messagingSocketPath, peerProtocol, ...(token ? { token } : {}) };
    }
    return null;
  }

  // Claude keeps the token beside the record, named by the sha256 of the socket path.
  // Without it the inbox still takes the message on Linux, so a missing key is not an error.
  private async peerToken(pid: number, socketPath: string): Promise<string | undefined> {
    const hash = createHash('sha256').update(socketPath).digest('hex');
    const key = await this.readJson(join(this.dirPath, `${pid}.${hash}.key`));
    const token = (key as { peerToken?: unknown } | null)?.peerToken;
    return typeof token === 'string' ? token : undefined;
  }

  private async readJson(path: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return null;
    }
  }

  // Another process writes these files while we read them, so a half-written or corrupted
  // one costs its own entry only — never the whole listing.
  private async read(path: string) {
    try {
      return parseClaudeSession(JSON.parse(await readFile(path, 'utf8')));
    } catch {
      return null;
    }
  }
}

// A SIGKILLed session leaves its record behind, so a record alone does not prove a live inbox.
// EPERM means the pid exists under another user.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
