import { basename } from 'node:path';
import type { IdGenerator } from '../ports/id-generator';
import { DuplicateSessionError, type TmuxPort } from '../ports/tmux-port';
import type { ParkedStorePort } from '../ports/parked-store-port';
import type { StatusStorePort } from '../ports/status-store-port';
import type { ClaudeSessionsPort } from '../ports/claude-sessions-port';

const SLUG_MAX = 20;

// The id lands in a tmux session name (which rejects `.` and `:`), in `claude --name` and
// unquoted in `@tarfa_command` (split on whitespace on unpark). It never holds `__`, which
// separates a workspace id from the rest of a browser session's name.
export function workspaceSlug(projectPath: string): string {
  const slug = basename(projectPath)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/_+/g, '_')
    .slice(0, SLUG_MAX)
    .replace(/^[-_]+|[-_]+$/g, '');
  return slug || 'ws';
}

export interface ShortWorkspaceIdsDeps {
  // Any tmux session, Tarfa's or not: a session tmux-resurrect brought back as a bare shell
  // carries no Tarfa marker, yet holds the name.
  tmux: Pick<TmuxPort, 'hasSession' | 'listSessions'>;
  sessionPrefix: string;
  parked: Pick<ParkedStorePort, 'list'>;
  status: Pick<StatusStorePort, 'ids'>;
  claudeSessions: ClaudeSessionsPort;
}

// `<folder>-<n>`, the smallest n nothing holds, so the id is easy to say aloud. Numbers are
// reused once a workspace is gone, which is why every place an old id can linger counts as taken.
export class ShortWorkspaceIds implements IdGenerator {
  constructor(private readonly deps: ShortWorkspaceIdsDeps) {}

  async next(projectPath: string): Promise<string> {
    const slug = workspaceSlug(projectPath);
    const addresses = await this.deps.claudeSessions.addressesByTmuxSession().catch(() => ({}));
    const parked = await this.deps.parked.list();
    const live = await this.deps.tmux.listSessions(this.deps.sessionPrefix);
    // A child outlives its orchestrator, and still names it as its parent (and messages it): the
    // next workspace to take that id would adopt the child.
    const parents = [...live, ...parked].flatMap((w) => (w.parent ? [w.parent] : []));
    const taken = new Set<string>([
      ...parked.map((p) => p.id),
      ...this.deps.status.ids(),
      ...Object.values(addresses),
      ...parents,
    ]);
    for (let n = 1; ; n++) {
      const id = `${slug}-${n}`;
      if (!taken.has(id) && !(await this.deps.tmux.hasSession(id))) return id;
    }
  }
}

const CLAIM_ATTEMPTS = 5;

// The free id is only a guess until tmux creates the session: another spawn or the Create form
// can take it in between. tmux refuses a duplicate name, so on that refusal ask again: the id
// that was lost is a live session now, and the next answer skips it.
export async function createWithFreshId(
  ids: IdGenerator,
  projectPath: string,
  create: (id: string) => Promise<void>,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const id = await ids.next(projectPath);
    try {
      await create(id);
      return id;
    } catch (err) {
      if (!(err instanceof DuplicateSessionError) || attempt >= CLAIM_ATTEMPTS) throw err;
    }
  }
}
