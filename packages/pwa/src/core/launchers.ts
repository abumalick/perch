// The built-in commands, each with the models it can launch with.
// A model is appended as `--model '<value>'`; "custom" reveals a free-text field instead.
// The value is single-quoted because tmux runs the command string through the login shell,
// and `opus[1m]` is a glob pattern there: under zsh an unmatched glob aborts the whole
// command line, so the session would die before `claude` ever started. Quoting every model
// keeps that from coming back with the next value someone adds.
// Every value is an alias, never a pinned id: the CLI resolves an alias to the newest model
// in that family at launch, so a new release lands here with no edit. Pinning
// (`claude-fable-5-1`) would freeze the picker one release behind, forever.
// Opus 5 and Sonnet 5 are natively 1M, so their `[1m]` suffix is a no-op the CLI strips —
// kept because it is what ships and works, not because it still buys anything. Haiku is the
// one 200K entry and can't be raised: Haiku 4.5 has no 1M window, so
// `claude-haiku-4-5[1m]` is rejected with a 400.
export type Model = { value: string; label: string };
type Builtin = { id: 'claude' | 'codex' | 'bash'; label: string; base: string; models: Model[] };
const BUILTINS: Builtin[] = [
  {
    id: 'claude',
    label: 'Claude',
    base: 'claude',
    models: [
      { value: 'opus[1m]', label: 'Opus' },
      { value: 'sonnet[1m]', label: 'Sonnet' },
      { value: 'haiku', label: 'Haiku' },
      { value: 'fable', label: 'Fable' },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    // Codex's shared daemon runs hooks outside the workspace's pane, where they cannot tell
    // which workspace they belong to, so Perch statuses only work without it.
    base: 'codex --no-daemon',
    models: [
      { value: 'gpt-6.1-sol', label: 'gpt-6.1-sol' },
      { value: 'gpt-6-astra', label: 'gpt-6-astra' },
      { value: 'gpt-6-luna', label: 'gpt-6-luna' },
    ],
  },
  { id: 'bash', label: 'Bash', base: 'bash', models: [] },
];

export type LauncherOption = { id: string; label: string; base: string; models: Model[]; removable: boolean };

export type LauncherReply = { detected: string[]; custom: string[] };

// The Command radios for one machine. Before the agent has answered (or when it is too old to
// know `listLaunchers`) the fixed list is offered. Bash is always there, whatever was found.
export function buildLauncherOptions(reply: LauncherReply | undefined): LauncherOption[] {
  const builtin = (b: Builtin): LauncherOption => ({ ...b, removable: false });
  if (!reply) return BUILTINS.map(builtin);
  const shown = BUILTINS.filter((b) => b.id === 'bash' || reply.detected.includes(b.id));
  const custom = reply.custom.map((c): LauncherOption => ({ id: `custom:${c}`, label: c, base: c, models: [], removable: true }));
  return [...shown.map(builtin), ...custom];
}
