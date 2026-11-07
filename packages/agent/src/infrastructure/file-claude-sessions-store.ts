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

  async inboxOf(tmuxSession: string, firstPane?: string | null): Promise<ClaudeInbox | null | 'ambiguous'> {
    let files: string[];
    try {
      files = await readdir(this.dirPath);
    } catch {
      return null;
    }
    const live: Array<{ pid: number; pane: string; socketPath: string; peerProtocol: number; print: boolean }> = [];
    for (const f of files.filter((name) => name.endsWith('.json'))) {
      const raw = await this.readJson(join(this.dirPath, f));
      if (typeof raw !== 'object' || raw === null) continue;
      const { pid, tmux, messagingSocketPath, peerProtocol, entrypoint } = raw as Record<string, unknown>;
      if (typeof tmux !== 'string' || tmux.split(':')[0] !== tmuxSession) continue;
      if (typeof pid !== 'number' || !isAlive(pid)) continue;
      if (typeof messagingSocketPath !== 'string' || typeof peerProtocol !== 'number') continue;
      // `tmux` is "<session>:@<window>.%<pane>".
      live.push({
        pid,
        pane: tmux.split('.').pop() ?? '',
        socketPath: messagingSocketPath,
        peerProtocol,
        print: typeof entrypoint === 'string' && entrypoint.startsWith('sdk-'),
      });
    }
    if (live.length === 0) return null;
    // A `claude -p` run or SDK process registers an inbox too, on the pane of whichever session
    // started it, and says `kind: "interactive"` like any other; only `entrypoint` differs.
    const interactive = live.filter((r) => !r.print);
    const candidates = interactive.length > 0 ? interactive : live;
    const onFirst = candidates.length > 1 ? candidates.filter((r) => firstPane && r.pane === firstPane) : candidates;
    if (onFirst.length !== 1) return 'ambiguous';
    const { pid, socketPath, peerProtocol } = onFirst[0]!;
    const token = await this.peerToken(pid, socketPath);
    return { socketPath, peerProtocol, ...(token ? { token } : {}) };
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
