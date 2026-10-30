import type { TmuxPort } from '../ports/tmux-port';
import type { FileWriterPort } from '../ports/file-writer-port';
import type { IdGenerator } from '../ports/id-generator';

export interface SpawnWorkspaceDeps {
  tmux: Pick<TmuxPort, 'createSession' | 'hasSession'> & Required<Pick<TmuxPort, 'setPaneTitle'>>;
  files: FileWriterPort;
  // The directory's absolute, symlink-free path, or null when it is not a directory.
  resolveDirectory: (path: string) => Promise<string | null>;
  ids: IdGenerator;
  sleep: (ms: number) => Promise<void>;
  // Where briefs and a child's hook files go (~/.perch/spawn).
  spawnDir: string;
  // The program started; `claude` outside tests.
  launcher?: string;
}

export interface SpawnWorkspaceInput {
  projectPath: string;
  brief: string;
  model?: string;
  title?: string;
  // The orchestrator workspace this one reports to, and the name SendMessage reaches it by.
  parent?: { id: string; name: string };
}

const LAUNCH_CHECK_MS = 2000;

// Starts a workspace running Claude Code on a brief; returns its id, which is also the Claude
// session's name. The brief is written to a file and the command holds only that fixed path:
// the login shell expands "$(cat '<file>')" into one argv element and never re-parses it, so
// quotes, backticks, $ and newlines in the brief arrive untouched. Do NOT "simplify" this by
// interpolating the brief into the command string.
export async function spawnWorkspace(deps: SpawnWorkspaceDeps, input: SpawnWorkspaceInput): Promise<string> {
  const model = input.model ?? 'opus[1m]';
  const { parent, title } = input;
  // `tmux new-session -c` silently runs in $HOME when the cwd is missing.
  const cwd = await deps.resolveDirectory(input.projectPath);
  if (!cwd) throw new Error(`not a directory: ${input.projectPath}`);
  if (!/\S/.test(input.brief)) throw new Error('empty brief on stdin');
  if (!/^[A-Za-z0-9._:[\]-]+$/.test(model)) throw new Error(`unsafe model name: ${model}`);
  // The brief path sits inside single quotes. A child's settings path lands unquoted in
  // @perch_command, which resumeCommand splits on whitespace and tmux runs through a login shell.
  const dir = deps.spawnDir;
  if (dir.includes("'") || (parent && !/^[A-Za-z0-9._/-]+$/.test(dir))) {
    throw new Error(`the spawn directory must have no spaces or quotes: ${dir}`);
  }
  if (parent && !/^perch-[A-Za-z0-9_-]+$/.test(parent.id)) throw new Error(`not a Perch workspace id for the parent: ${parent.id}`);

  const id = `perch-${deps.ids.next()}`;
  const briefPath = `${dir}/${id}.md`;
  const brief = input.brief.replace(/\n+$/, '') + (parent ? childFooter(parent) : '');
  await deps.files.ensureDir(dir);
  await write(deps.files, briefPath, `${brief}\n`);

  let base = `${deps.launcher ?? 'claude'} --model '${model}' --name ${id}`;
  if (parent) {
    // A child must not block on a question its orchestrator could answer: a peer message can
    // never answer a pending AskUserQuestion, and none can take a child out of plan mode. The
    // hook denies those tools, and its reason redirects the model to SendMessage. It lives in a
    // file rather than an env var because unpark runs `<base> --resume <sid> || exec <base>`,
    // where an env prefix breaks the `exec`.
    const denyPath = `${dir}/${id}.deny.json`;
    const settingsPath = `${dir}/${id}.settings.json`;
    await write(deps.files, denyPath, `${JSON.stringify(denyHook(parent))}\n`);
    await write(deps.files, settingsPath, `${JSON.stringify(denySettings(denyPath))}\n`);
    base = `${base} --settings ${settingsPath}`;
  }

  // Without a title, Claude Code names the workspace itself through the pane title. With one,
  // CLAUDE_CODE_DISABLE_TERMINAL_TITLE stops it overwriting ours a second later (an env prefix,
  // as tmux's `-e` wants tmux 3.2), and the title carries the status glyph because
  // deriveWorkspaceName trusts only a pane title that has one.
  const launch = `${title ? 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 ' : ''}${base} "$(cat '${briefPath}')"`;
  // The stored command omits the brief: unpark builds `<base> --resume <sid> || exec <base>`
  // from it, and the brief would be re-submitted into the conversation on every unpark.
  await deps.tmux.createSession({ name: id, cwd, command: launch, storedCommand: base, ...(parent ? { parent: parent.id } : {}) });
  if (title) await deps.tmux.setPaneTitle(id, `✳ ${title}`);

  // A command string the login shell rejects kills the pane at once, and tmux then destroys the
  // session: the workspace would just never appear, with no error.
  await deps.sleep(LAUNCH_CHECK_MS);
  if (!(await deps.tmux.hasSession(id))) throw new Error(`workspace ${id} died on launch (brief kept at ${briefPath})`);
  return id;
}

function write(files: FileWriterPort, path: string, text: string): Promise<void> {
  return files.writeFile(path, new TextEncoder().encode(text));
}

function childFooter({ id, name }: { id: string; name: string }): string {
  return `

---
You were launched by the orchestrator workspace ${id} (its Claude session is "${name}"), and you
report to it, not to the user. Ask it your questions with the SendMessage tool (to: "${name}"),
then end your turn: its reply arrives as a message and wakes you. Its name can change: if
SendMessage cannot find "${name}", run \`perch ls\` and look for workspace ${id} to get its current
name (the NAME column). A permission prompt is the exception: a yes relayed by the orchestrator
never answers it, so when you hit one, tell the orchestrator what it is for and leave it open for
the user to answer in this pane. As your last action, send it your final report the same way:
what you did, what you verified, and anything left open.`;
}

function denyHook({ id, name }: { id: string; name: string }) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `You are run by the orchestrator workspace ${id} (Claude session "${name}"). Do not ask the user or use plan mode. ` +
        `Send any question to "${name}" with the SendMessage tool, then end your turn; its reply will arrive as a message. ` +
        `If SendMessage cannot find it, run \`perch ls\` and look for workspace ${id} to get its current name.`,
    },
  };
}

function denySettings(denyPath: string) {
  return {
    hooks: {
      PreToolUse: [
        { matcher: 'AskUserQuestion|EnterPlanMode|ExitPlanMode', hooks: [{ type: 'command', command: `cat >/dev/null; cat ${denyPath}` }] },
      ],
    },
  };
}
