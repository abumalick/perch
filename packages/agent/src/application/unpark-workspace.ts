import type { TmuxPort } from '../ports/tmux-port';
import type { StatusStorePort } from '../ports/status-store-port';
import type { ParkedStorePort } from '../ports/parked-store-port';
import type { DirectoryChecker } from '../ports/directory-checker';
import { resumeCommand } from './resume-command';

export type UnparkResult = 'not-parked' | 'unparked' | 'missing-directory';

export interface UnparkWorkspaceDeps {
  parked: Pick<ParkedStorePort, 'get' | 'remove'>;
  tmux: Pick<TmuxPort, 'createSession' | 'supportsTitleLock' | 'lockPaneTitle' | 'setPaneTitle'>;
  isDirectory: DirectoryChecker;
  status: Pick<StatusStorePort, 'set'>;
}

// Brings a parked workspace back: recreates its tmux session with the Claude conversation
// resumed, then clears the parked record. `not-parked` means the id has no record and the
// caller should proceed with a normal attach.
//
// The workspace id is reused deliberately — the PWA routes attach/input/close by workspace
// id, so minting a fresh one (as createWorkspace does) would orphan client state. That is
// why this bypasses createWorkspace; the directory guard below is the one piece of
// createWorkspace it must NOT skip.
export async function unparkWorkspace(
  deps: UnparkWorkspaceDeps,
  id: string,
): Promise<UnparkResult> {
  const record = await deps.parked.get(id);
  if (!record) {
    return 'not-parked';
  }
  // `tmux new-session -c` silently runs the command in $HOME when the cwd is missing, and
  // Claude scopes session-id lookup to the project directory — so a deleted project would
  // both resume in the wrong place and fail to find the conversation. Keep the record so
  // the workspace stays listed and the user can still close it deliberately.
  if (!(await deps.isDirectory(record.projectPath))) {
    return 'missing-directory';
  }
  await deps.tmux.createSession({
    name: record.id,
    cwd: record.projectPath,
    command: resumeCommand(record.command, record.claudeSessionId),
    ...(record.parent ? { parent: record.parent } : {}),
  });
  // The workspace's name is its pane title, and the resumed Claude would write a new one: the
  // bare id for a `--name perch-…` spawn, a fresh summary otherwise. So the parked name is put
  // back, glyph-prefixed because deriveWorkspaceName trusts only such a title, and locked on
  // every unpark (tmux 3.5+): unlocked it would last until Claude's first title write. The
  // record cannot tell an explicit `--title` from a name Claude chose, and a frozen known name
  // beats one that moves to something the user does not recognise. Where tmux cannot lock, the
  // title is still set, best-effort: the spawn's env switch would cover only the left half of
  // `<cmd> --resume <id> || exec <cmd>`, and it silences Claude's OSC 7501 status too.
  // A failure here must not fail the unpark: the session already exists, and the record must go.
  await restoreName(deps.tmux, record.id, record.name).catch(() => undefined);
  await deps.parked.remove(record.id);
  // Back to a normal live workspace. The next hook event moves it to `working`.
  deps.status.set(record.id, 'idle');
  return 'unparked';
}

async function restoreName(tmux: UnparkWorkspaceDeps['tmux'], id: string, name: string): Promise<void> {
  if (tmux.lockPaneTitle && (await tmux.supportsTitleLock?.())) await tmux.lockPaneTitle(id);
  await tmux.setPaneTitle?.(id, `✳ ${name}`);
}
