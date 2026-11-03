import type { TmuxPort } from '../ports/tmux-port';
import type { ParkedStorePort } from '../ports/parked-store-port';

export interface RenameWorkspaceDeps {
  tmux: Pick<TmuxPort, 'hasSession' | 'supportsTitleLock' | 'lockPaneTitle'> & Required<Pick<TmuxPort, 'setPaneTitle'>>;
  parked: Pick<ParkedStorePort, 'get'>;
}

const TITLE_MAX = 100;

// Gives a live workspace the title the user chose. A workspace's name is its pane title, so this
// is the unpark path: `✳ <title>` (the glyph deriveWorkspaceName trusts) under a lock, which also
// stops Claude renaming it from then on. The id and the Claude session's name are left alone.
// The agent's poll sees the new name and tells the phones.
export async function renameWorkspace(deps: RenameWorkspaceDeps, id: string, title: string): Promise<{ locked: boolean }> {
  const name = title.trim();
  if (!name) throw new Error('the title is empty');
  if (/\p{Cc}/u.test(name)) throw new Error('the title has a control character');
  if (name.length > TITLE_MAX) throw new Error(`the title is longer than ${TITLE_MAX} characters`);
  if (!(await deps.tmux.hasSession(id))) {
    if (await deps.parked.get(id)) throw new Error(`${id} is parked: open it first (perch unpark ${id})`);
    throw new Error(`no workspace ${id} (see perch ls)`);
  }
  const locked = Boolean(deps.tmux.lockPaneTitle && (await deps.tmux.supportsTitleLock?.()));
  if (locked) await deps.tmux.lockPaneTitle!(id);
  await deps.tmux.setPaneTitle(id, `✳ ${name}`);
  return { locked };
}
