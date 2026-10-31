import { describe, it, expect, vi } from 'vitest';
import { spawnWorkspace, type SpawnWorkspaceDeps } from './spawn-workspace';

const DIR = '/home/u/.perch/spawn';

function makeDeps(overrides: Partial<SpawnWorkspaceDeps> = {}) {
  const files = new Map<string, string>();
  const tmux = {
    createSession: vi.fn(async (_input: { name: string; cwd: string; command: string; parent?: string; storedCommand?: string }) => {}),
    setPaneTitle: vi.fn(async (_name: string, _title: string) => {}),
    hasSession: vi.fn(async (_name: string) => true),
  };
  const sleep = vi.fn(async (_ms: number) => {});
  const deps: SpawnWorkspaceDeps = {
    tmux,
    files: {
      ensureDir: vi.fn(async () => {}),
      exists: async (path) => files.has(path),
      writeFile: async (path, bytes) => {
        files.set(path, new TextDecoder().decode(bytes));
      },
    },
    resolveDirectory: async (path) => (path === '/w/proj' || path === 'proj' ? '/w/proj' : null),
    ids: { next: () => 'a1b2c3' },
    sleep,
    spawnDir: DIR,
    ...overrides,
  };
  return { deps, tmux, files, sleep };
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

  it('writes the brief to <spawnDir>/<id>.md, trailing newlines trimmed to one', async () => {
    const { deps, files } = makeDeps();
    await spawnWorkspace(deps, { projectPath: '/w/proj', brief: "don't `x` $y\nline 2\n\n" });
    expect(deps.files.ensureDir).toHaveBeenCalledWith(DIR);
    expect(files.get(`${DIR}/perch-a1b2c3.md`)).toBe("don't `x` $y\nline 2\n");
  });

  // The whole design: the brief never enters the command string, only a fixed path does.
  it('launches claude on the brief file, never on the brief text', async () => {
    const { deps, tmux } = makeDeps();
    await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'Hostile $(whoami) `id`' });
    expect(created(tmux).command).toBe(`claude --model 'opus[1m]' --name perch-a1b2c3 "$(cat '${DIR}/perch-a1b2c3.md')"`);
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
  });

  describe('a child', () => {
    const parent = { id: 'perch-p00001', name: 'relay "orchestrator"' };
    const settings = `${DIR}/perch-a1b2c3.settings.json`;

    it('records its parent on the session', async () => {
      const { deps, tmux } = makeDeps();
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', parent });
      expect(created(tmux).parent).toBe('perch-p00001');
    });

    it('passes --settings in both the launched and the stored command', async () => {
      const { deps, tmux } = makeDeps();
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', parent });
      expect(created(tmux).storedCommand).toBe(`claude --model 'opus[1m]' --name perch-a1b2c3 --settings ${settings}`);
      expect(created(tmux).command).toBe(`claude --model 'opus[1m]' --name perch-a1b2c3 --settings ${settings} "$(cat '${DIR}/perch-a1b2c3.md')"`);
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
          hooks: [{ type: 'command', command: `cat >/dev/null; cat ${DIR}/perch-a1b2c3.deny.json` }],
        },
      ]);
      const deny = JSON.parse(files.get(`${DIR}/perch-a1b2c3.deny.json`)!) as {
        hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
      };
      expect(deny.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(deny.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(deny.hookSpecificOutput.permissionDecisionReason).toContain('perch-p00001');
      expect(deny.hookSpecificOutput.permissionDecisionReason).toContain('relay "orchestrator"');
      expect(deny.hookSpecificOutput.permissionDecisionReason).toContain('perch ls');
    });

    it('appends a footer naming the parent id and its messaging name, with the perch ls fallback', async () => {
      const { deps, files } = makeDeps();
      await spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'Do the thing.', parent });
      const brief = files.get(`${DIR}/perch-a1b2c3.md`)!;
      expect(brief.startsWith('Do the thing.\n\n---\n')).toBe(true);
      expect(brief).toContain('workspace perch-p00001');
      expect(brief).toContain('SendMessage tool (to: "relay "orchestrator"")');
      expect(brief).toMatch(/run `perch ls` and look for workspace perch-p00001/);
      expect(brief).toContain('A permission prompt is the exception');
      expect(brief).toContain('final report');
    });

    it('refuses a parent that is not a Perch workspace id', async () => {
      const { deps } = makeDeps();
      await expect(spawnWorkspace(deps, { projectPath: '/w/proj', brief: 'b', parent: { id: 'main', name: 'x' } })).rejects.toThrow(/parent/);
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
      expect([...files.keys()]).toEqual([`${DIR}/perch-a1b2c3.md`]);
      expect(files.get(`${DIR}/perch-a1b2c3.md`)).toBe('b\n');
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
      `workspace perch-a1b2c3 died on launch (brief kept at ${DIR}/perch-a1b2c3.md)`,
    );
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(sleep.mock.invocationCallOrder[0]!).toBeLessThan(tmux.hasSession.mock.invocationCallOrder[0]!);
  });
});
