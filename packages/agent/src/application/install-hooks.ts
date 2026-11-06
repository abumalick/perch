const HOOK_EVENTS = [
  'Stop',
  'Notification',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  // Fired instead of Stop when an API error ends the turn.
  'StopFailure',
  // A new `claude` process or conversation: drops what the previous one left behind.
  'SessionStart',
] as const;

// Codex has no Notification event; it asks for approval through PermissionRequest instead.
// SessionEnd is left out on purpose: it can fire late, from a newer Codex process, and would
// stamp a status onto whichever workspace that process runs in.
const CODEX_HOOK_EVENTS = ['Stop', 'PermissionRequest', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const;

// Markers that identify a Tarfa-registered hook command, regardless of the path form (stable
// `~/.tarfa/...`, a legacy absolute repo path) or of the name it had before the rename (perch-*).
// Used to strip stale entries so re-running install-hooks is idempotent.
const TARFA_HOOK_MARKERS = ['tarfa-hook.sh', 'tarfa-guard.sh', 'perch-hook.sh', 'perch-guard.sh'];

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: 'command'; command: string }>;
}

function isTarfaEntry(entry: HookEntry): boolean {
  return entry.hooks.some((h) => TARFA_HOOK_MARKERS.some((marker) => h.command.includes(marker)));
}

export function installHooks(
  deps: { settings: Record<string, unknown> },
  // `agent` installs into Codex's hooks.json, which takes the same shape as Claude's settings.
  // `guardCommand` refuses kill-by-name commands before Bash runs them (tarfa-guard.sh).
  params: { hookCommand: string; guardCommand?: string; port: number; agent?: 'codex' },
): Record<string, unknown> {
  const settings = { ...deps.settings };
  const existingHooks = (settings.hooks as Record<string, HookEntry[]> | undefined) ?? {};
  const hooks: Record<string, HookEntry[]> = { ...existingHooks };

  const events = params.agent === 'codex' ? CODEX_HOOK_EVENTS : HOOK_EVENTS;
  const suffix = params.agent ? ` ${params.agent}` : '';
  for (const event of events) {
    const command = `${params.hookCommand} ${event} ${params.port}${suffix}`;
    // Drop any prior Tarfa entry (including legacy absolute-path commands) so
    // the stable, machine-identical command fully replaces it.
    const entries = (hooks[event] ?? []).filter((entry) => !isTarfaEntry(entry));
    entries.push({ hooks: [{ type: 'command', command }] });
    hooks[event] = entries;
  }
  if (params.guardCommand) {
    hooks.PreToolUse = [
      ...(hooks.PreToolUse ?? []),
      { matcher: 'Bash', hooks: [{ type: 'command', command: params.guardCommand }] },
    ];
  }

  settings.hooks = hooks;
  return settings;
}
