import { describe, it, expect, vi } from 'vitest';
import { spawnWorkspace, type SpawnWorkspaceDeps } from './spawn-workspace';

const DIR = '/home/u/.perch/spawn';

function makeDeps(overrides: Partial<SpawnWorkspaceDeps> = {}) {
  const files = new Map<string, string>();
  const tmux = {
    createSession: vi.fn(async (_input: { name: string; cwd: string; command: string; parent?: string; storedCommand?: string; codexThread?: string }) => {}),
    setPaneTitle: vi.fn(async (_name: string, _title: string) => {}),
    hasSession: vi.fn(async (_name: string) => true),
  };
  const sleep = vi.fn(async (_ms: number) => {});
  const codex = {
    versions: vi.fn(async () => ({ cli: '0.166.0', appServer: '0.166.0' })),
    createThread: vi.fn(async (_input: { cwd: string; model?: string; developerInstructions?: string; firstMessage: string }) => 'th-1'),
  };
  const deps: SpawnWorkspaceDeps = {
    codex,
    tmux,
    files: {
      ensureDir: vi.fn(async () => {}),
      exists: async (path) => files.has(path),
      writeFile: async (path, bytes) => {
        files.set(path, new TextDecoder().decode(bytes));
      },
    },
    resolveDirectory: async (path) => (path === '/w/proj' || path === 'proj' ? '/w/proj' : null),
    ids: { next: async () => 'perch-a1b2c3' },
    nonce: () => 'n0nce',
    sleep,
    spawnDir: DIR,
    ...overrides,
  };
  return { deps, tmux, files, sleep, codex };
}

const created = (tmux: ReturnType<typeof makeDeps>['tmux']) => tmux.createSession.mock.calls[0]![0];

describe('spawnWorkspace', () => {
  it('names the workspace perch-<6 hex> and returns the id', async () => {
    const { deps, tmux } = makeDeps();
    expect(await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'Do it.' })).toBe('perch-a1b2c3');
    expect(created(tmux).name).toBe('perch-a1b2c3');
  });

  // `tmux new-session -c` silently runs in $HOME when the cwd is missing.
  it('starts in the resolved directory, and refuses one that is not a directory', async () => {
    const { deps, tmux } = makeDeps();
    await spawnWorkspace(deps, { projectPath: 'proj', brief: 'b' });
    expect(created(tmux).cwd).toBe('/w/proj');
    await expect(spawnWorkspace(deps, { projectPath: '/nope', brief: 'b' })).rejects.toThrow('not a directory: /nope');
  });

  it('refuses a whitespace-only brief before creating anything', async () => {
    const { deps, tmux } = makeDeps();
    await expect(spawnWorkspace(deps, { projectPath: '/w/proj', brief: ' \n\t ' })).rejects.toThrow(/empty brief/);
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it('writes the brief to <spawnDir>/<nonce>.md, trailing newlines trimmed to one', async () => {
    const { deps, files } = makeDeps();
    await spawnWorkspace(deps, { projectPath: '/w/proj', brief: "don't `x` $y\nline 2\n\n" });
    expect(deps.files.ensureDir).toHaveBeenCalledWith(DIR);
    expect(files.get(`${DIR}/n0nce.md`)).toBe("don't `x` $y\nline 2\n");
  });

  // The whole design: the brief never enters the command string, only a fixed path does.
  it('launches claude on the brief file, never on the brief text', async () => {
    const { deps, tmux } = makeDeps();
    await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'Hostile $(whoami) `id`' });
    expect(created(tmux).command).toBe(`claude --model 'opus[1m]' --name perch-a1b2c3 "$(cat '${DIR}/n0nce.md')"`);
    expect(created(tmux).command).not.toContain('whoami');
  });

  // resumeCommand splits this to build the unpark command; the brief would be re-submitted.
  it('stores @perch_command as the base command, without the brief', async () => {
    const { deps, tmux } = makeDeps();
    await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', model: 'sonnet[1m]' });
    expect(created(tmux).storedCommand).toBe("claude --model 'sonnet[1m]' --name perch-a1b2c3");
  });

  it('refuses a model that would break its quotes', async () => {
    const { deps } = makeDeps();
    await expect(spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', model: "x' ; rm" })).rejects.toThrow(/model/);
  });

  it('runs the launcher it is given', async () => {
    const { deps, tmux } = makeDeps({ launcher: '/t/fake-claude' });
    await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b' });
    expect(created(tmux).command.startsWith("/t/fake-claude --model 'opus[1m]'")).toBe(true);
  });

  describe('--title', () => {
    it('sets the pane title with the status glyph, and stops Claude Code renaming it', async () => {
      const { deps, tmux } = makeDeps();
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', title: 'story 9' });
      expect(tmux.setPaneTitle).toHaveBeenCalledWith('perch-a1b2c3', '✳ story 9');
      expect(created(tmux).command.startsWith('CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 claude ')).toBe(true);
      expect(created(tmux).storedCommand).toBe("claude --model 'opus[1m]' --name perch-a1b2c3");
    });

    it('leaves both alone without one', async () => {
      const { deps, tmux } = makeDeps();
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b' });
      expect(tmux.setPaneTitle).not.toHaveBeenCalled();
      expect(created(tmux).command).not.toContain('CLAUDE_CODE_DISABLE_TERMINAL_TITLE');
    });

    // The env switch also silences Claude's OSC 7501 status, so where tmux can refuse the
    // title itself (allow-set-title, tmux 3.5+) the pane is locked instead, before the title.
    it('locks the pane title instead when tmux can, so Claude still reports its status', async () => {
      const order: string[] = [];
      const lockPaneTitle = vi.fn(async (_name: string) => void order.push('lock'));
      const { deps, tmux } = makeDeps();
      tmux.setPaneTitle.mockImplementation(async () => void order.push('title'));
      deps.tmux = { ...tmux, supportsTitleLock: async () => true, lockPaneTitle };
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', title: 'story 9' });
      expect(created(tmux).command).not.toContain('CLAUDE_CODE_DISABLE_TERMINAL_TITLE');
      expect(lockPaneTitle).toHaveBeenCalledWith('perch-a1b2c3');
      expect(order).toEqual(['lock', 'title']);
    });

    it('keeps the env switch where tmux cannot lock the title', async () => {
      const lockPaneTitle = vi.fn(async (_name: string) => {});
      const { deps, tmux } = makeDeps();
      deps.tmux = { ...tmux, supportsTitleLock: async () => false, lockPaneTitle };
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', title: 'story 9' });
      expect(created(tmux).command.startsWith('CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 claude ')).toBe(true);
      expect(lockPaneTitle).not.toHaveBeenCalled();
    });
  });

  describe('a child', () => {
    const parent = { id: 'perch-p00001' };
    const settings = `${DIR}/n0nce.settings.json`;

    it('records its parent on the session', async () => {
      const { deps, tmux } = makeDeps();
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', parent });
      expect(created(tmux).parent).toBe('perch-p00001');
    });

    it('passes --settings in both the launched and the stored command', async () => {
      const { deps, tmux } = makeDeps();
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', parent });
      expect(created(tmux).storedCommand).toBe(`claude --model 'opus[1m]' --name perch-a1b2c3 --settings ${settings}`);
      expect(created(tmux).command).toBe(`claude --model 'opus[1m]' --name perch-a1b2c3 --settings ${settings} "$(cat '${DIR}/n0nce.md')"`);
    });

    it('writes a hook that denies questions and plan mode, naming the parent', async () => {
      const { deps, files } = makeDeps();
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', parent });
      const hooks = JSON.parse(files.get(settings)!) as {
        hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
      };
      expect(hooks.hooks.PreToolUse).toEqual([
        {
          matcher: 'AskUserQuestion|EnterPlanMode|ExitPlanMode',
          hooks: [{ type: 'command', command: `cat >/dev/null; cat ${DIR}/n0nce.deny.json` }],
        },
      ]);
      const deny = JSON.parse(files.get(`${DIR}/n0nce.deny.json`)!) as {
        hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
      };
      expect(deny.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(deny.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('the deny reason names perch send and the parent id', async () => {
      const { deps, files } = makeDeps();
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', parent });
      const reason = (JSON.parse(files.get(`${DIR}/n0nce.deny.json`)!) as { hookSpecificOutput: { permissionDecisionReason: string } })
        .hookSpecificOutput.permissionDecisionReason;
      expect(reason).toContain('perch send perch-p00001 "');
      expect(reason).not.toContain('SendMessage');
    });

    it('appends a footer telling it to ask the parent with perch send', async () => {
      const { deps, files } = makeDeps();
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'Do the thing.', parent });
      const brief = files.get(`${DIR}/n0nce.md`)!;
      expect(brief.startsWith('Do the thing.\n\n---\n')).toBe(true);
      expect(brief).toContain('workspace perch-p00001');
      expect(brief).toContain('perch send perch-p00001 "');
      expect(brief).not.toContain('SendMessage');
      expect(brief).toContain('A permission prompt is the exception');
      expect(brief).toContain('final report');
    });

    // The parent id lands unquoted in the child's hook files and brief.
    it('refuses a parent id with characters an id never has', async () => {
      const { deps } = makeDeps();
      await expect(spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', parent: { id: 'main; x' } })).rejects.toThrow(/parent/);
    });

    // The settings path lands unquoted in @perch_command, which unpark splits on whitespace.
    it('refuses a spawn directory a command line would split', async () => {
      const { deps, tmux } = makeDeps({ spawnDir: '/home/a b/.perch/spawn' });
      await expect(spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', parent })).rejects.toThrow(/spawn directory/);
      expect(tmux.createSession).not.toHaveBeenCalled();
    });

    it('writes no settings and no footer for a workspace without a parent', async () => {
      const { deps, files, tmux } = makeDeps();
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b' });
      expect([...files.keys()]).toEqual([`${DIR}/n0nce.md`]);
      expect(files.get(`${DIR}/n0nce.md`)).toBe('b\n');
      expect(created(tmux).parent).toBeUndefined();
    });
  });

  it('accepts a spawn directory with a space when there is no parent (the brief path is quoted)', async () => {
    const { deps } = makeDeps({ spawnDir: '/home/a b/.perch/spawn' });
    await expect(spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b' })).resolves.toBe('perch-a1b2c3');
  });

  it("refuses a spawn directory with a quote, which would end the brief path's quotes", async () => {
    const { deps } = makeDeps({ spawnDir: "/home/o'neil/.perch/spawn" });
    await expect(spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b' })).rejects.toThrow(/spawn directory/);
  });

  // A command the login shell rejects kills the pane at once, and tmux drops the session.
  it('checks the session is still alive two seconds after launch', async () => {
    const { deps, tmux, sleep } = makeDeps();
    tmux.hasSession.mockResolvedValue(false);
    await expect(spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b' })).rejects.toThrow(
      `workspace perch-a1b2c3 died on launch (brief kept at ${DIR}/n0nce.md)`,
    );
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(sleep.mock.invocationCallOrder[0]!).toBeLessThan(tmux.hasSession.mock.invocationCallOrder[0]!);
  });

  describe('--cli codex', () => {
    const parent = { id: 'perch-p00001' };

    it('spawns a codex child with its thread recorded and @perch_parent set', async () => {
      const { deps, tmux, codex } = makeDeps();
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'Do $(it).', cli: 'codex', parent, model: 'gpt-5.5' });
      const thread = codex.createThread.mock.calls[0]![0];
      expect(thread.cwd).toBe('/w/proj');
      expect(thread.model).toBe('gpt-5.5');
      expect(thread.firstMessage).toBe('Do $(it).');
      expect(thread.developerInstructions).toContain('orchestrator workspace perch-p00001');
      expect(thread.developerInstructions).toContain('perch send perch-p00001 "');
      expect(thread.developerInstructions).toContain('escalated');
      expect(thread.developerInstructions).toContain('[Perch message — from your ORCHESTRATOR]');
      expect(created(tmux)).toMatchObject({ name: 'perch-a1b2c3', cwd: '/w/proj', parent: 'perch-p00001', codexThread: 'th-1' });
    });

    // Any -c / --enable / --search / --no-daemon makes the TUI hold the thread itself.
    it('launches and stores exactly codex resume <thread id>', async () => {
      const { deps, tmux } = makeDeps();
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', cli: 'codex', title: 'T' });
      expect(created(tmux).command).toBe('codex resume th-1');
      // No separate stored command: @perch_command records the launch itself.
      expect(created(tmux).storedCommand ?? created(tmux).command).toBe('codex resume th-1');
      expect(tmux.setPaneTitle).toHaveBeenCalledWith('perch-a1b2c3', '✳ T');
    });

    it('gives a codex spawn without a parent no developer instructions and no model of its own', async () => {
      const { deps, tmux, codex, files } = makeDeps();
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', cli: 'codex' });
      expect(codex.createThread.mock.calls[0]![0]).toEqual({ cwd: '/w/proj', firstMessage: 'b' });
      expect(created(tmux).parent).toBeUndefined();
      // The brief travels over JSON-RPC, never through a file or the command line.
      expect(files.size).toBe(0);
    });

    // An update chooser would block the TUI before it ever attaches to the thread.
    it('refuses a CLI and app server of different versions before anything exists', async () => {
      const { deps, tmux, codex, files } = makeDeps();
      codex.versions.mockResolvedValue({ cli: '0.163.0', appServer: '0.166.0' });
      await expect(spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', cli: 'codex', parent })).rejects.toThrow(
        'the Codex CLI (0.163.0) and its app server (0.166.0) differ: update codex first',
      );
      expect(codex.createThread).not.toHaveBeenCalled();
      expect(tmux.createSession).not.toHaveBeenCalled();
      expect(files.size).toBe(0);
    });

    it('creates one thread even when the first id is taken', async () => {
      const { deps, tmux, codex } = makeDeps();
      const { DuplicateSessionError } = await import('../ports/tmux-port');
      tmux.createSession.mockRejectedValueOnce(new DuplicateSessionError('perch-a1b2c3'));
      let n = 0;
      deps.ids = { next: async () => (n++ === 0 ? 'perch-a1b2c3' : 'perch-a1b2c4') };
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', cli: 'codex' });
      expect(codex.createThread).toHaveBeenCalledTimes(1);
    });
  });

  describe('--cli pi', () => {
    const parent = { id: 'perch-p00001' };

    it('spawns a pi child through pi-reviewed', async () => {
      const { deps, tmux, files } = makeDeps();
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'Do it.', cli: 'pi', parent, model: 'anthropic/claude-sonnet-4:high' });
      expect(created(tmux).command).toBe(`pi-reviewed --model 'anthropic/claude-sonnet-4:high' "$(cat '${DIR}/n0nce.md')"`);
      expect(created(tmux).storedCommand).toBe("pi-reviewed --model 'anthropic/claude-sonnet-4:high'");
      expect(created(tmux).parent).toBe('perch-p00001');
      expect([...files.keys()]).toEqual([`${DIR}/n0nce.md`]);
      const brief = files.get(`${DIR}/n0nce.md`)!;
      expect(brief).toContain('perch send perch-p00001 "');
      expect(brief).not.toContain('SendMessage');
    });

    it('runs pi-reviewed with no model of its own when none is given', async () => {
      const { deps, tmux } = makeDeps();
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', cli: 'pi', title: 'T' });
      expect(created(tmux).command).toBe(`pi-reviewed "$(cat '${DIR}/n0nce.md')"`);
      expect(created(tmux).storedCommand).toBe('pi-reviewed');
    });
  });
});
