import { describe, it, expect, vi, beforeEach } from 'vitest';

// No tmux server is touched here: execFile is replaced, so these check the arguments the adapter
// sends and how it parses tmux's answer.
const calls: string[][] = [];
const binaries: string[] = [];
let stdout = '';
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (err: null, res: { stdout: string; stderr: string }) => void) => {
    calls.push(args);
    binaries.push(cmd);
    cb(null, { stdout, stderr: '' });
  },
}));

const { TmuxAdapter } = await import('./tmux-adapter');

beforeEach(() => {
  calls.length = 0;
  stdout = '';
});

describe('TmuxAdapter (arguments)', () => {
  it('reads @tarfa_parent, @tarfa_codex_thread and the program status before the pane title, which stays last', async () => {
    await new TmuxAdapter().listSessions('perch-');
    const fields = calls[0]![2]!.split('|:|');
    expect(fields.slice(-8)).toEqual(['#{@tarfa_parent}', '#{@tarfa_codex_thread}', '#{@perch_command}', '#{@perch_parent}', '#{@perch_codex_thread}', '#{pane_program_state}', '#{pane_program_time}', '#{pane_title}']);
  });

  it('parses a parent, and omits an empty one', async () => {
    stdout = [
      'perch-a|:|/w|:|10|:|dev.example.com|:|dev|:|claude|:|perch-p|:||:||:||:||:||:||:|a|:|title',
      'perch-b|:|/w|:|10|:|dev.example.com|:|dev|:|claude|:||:||:||:||:||:||:||:|plain',
    ].join('\n');
    const [a, b] = await new TmuxAdapter().listSessions('perch-');
    expect(a).toEqual({ name: 'perch-a', startPath: '/w', command: 'claude', createdAt: 10_000, parent: 'perch-p', title: 'a|:|title' });
    expect(b).toEqual({ name: 'perch-b', startPath: '/w', command: 'claude', createdAt: 10_000, title: 'plain' });
  });

  it('parses a Codex thread, and omits an empty one', async () => {
    stdout = [
      'perch-a|:|/w|:|10|:|dev.example.com|:|dev|:|codex resume t1|:||:|t1|:||:||:||:||:||:|x',
      'perch-b|:|/w|:|10|:|dev.example.com|:|dev|:|codex|:||:||:||:||:||:||:||:|y',
    ].join('\n');
    const [a, b] = await new TmuxAdapter().listSessions('perch-');
    expect(a).toMatchObject({ name: 'perch-a', codexThread: 't1', title: 'x' });
    expect(b).not.toHaveProperty('codexThread');
  });

  // A short id (`perch-3`, `eng-ops-1`) can start with any folder name, so the prefix only
  // finds the old `perch-<hex>` ids; the `@tarfa_command` that Tarfa sets on every session finds
  // the rest. A session without either is somebody else's.
  it('lists a session Tarfa started under any name, and a prefixed one even without its marker', async () => {
    stdout = [
      'eng-ops-1|:|/w|:|10|:|dev.example.com|:|dev|:|claude|:||:||:||:||:||:||:||:|t',
      'perch-a|:|/w|:|10|:|dev.example.com|:|dev|:||:||:||:||:||:||:||:||:|t',
      'scratch|:|/w|:|10|:|dev.example.com|:|dev|:||:||:||:||:||:||:||:||:|t',
    ].join('\n');
    const names = (await new TmuxAdapter().listSessions('perch-')).map((s) => s.name);
    expect(names).toEqual(['eng-ops-1', 'perch-a']);
  });

  it("reads a pane title that is still tmux's host-name default as no title", async () => {
    stdout = [
      'perch-a|:|/w|:|10|:|dev.example.com|:|dev|:|claude|:||:||:||:||:||:||:||:|dev',
      'perch-b|:|/w|:|10|:|dev.example.com|:|dev|:|claude|:||:||:||:||:||:||:||:|dev.example.com',
      'perch-c|:|/w|:|10|:|dev.example.com|:|dev|:|claude|:||:||:||:||:||:||:||:|dev notes',
    ].join('\n');
    expect((await new TmuxAdapter().listSessions('perch-')).map((s) => s.title)).toEqual(['', '', 'dev notes']);
  });

  // A stock tmux expands the two fields to '', which must read as "no program status".
  it('parses the program status a patched tmux reports', async () => {
    stdout = 'perch-a|:|/w|:|10|:|dev.example.com|:|dev|:|claude|:||:||:||:||:||:|done|:|1700000000|:|t';
    const [a] = await new TmuxAdapter().listSessions('perch-');
    expect(a?.program).toEqual({ state: 'done', changedAt: 1_700_000_000_000 });
    expect(a?.title).toBe('t');
  });

  it('reads the @perch_ options an older agent set when the @tarfa_ ones are absent', async () => {
    stdout = [
      'perch-a|:|/w|:|10|:|h|:|h|:||:||:||:|claude|:|perch-p|:|t1|:||:||:|old',
      'perch-b|:|/w|:|10|:|h|:|h|:|codex|:|perch-q|:||:|claude|:|perch-p|:|t1|:||:||:|both',
    ].join('\n');
    const [a, b] = await new TmuxAdapter().listSessions('perch-');
    expect(a).toMatchObject({ command: 'claude', parent: 'perch-p', codexThread: 't1', title: 'old' });
    expect(b).toMatchObject({ command: 'codex', parent: 'perch-q', codexThread: 't1', title: 'both' });
  });

  it('re-tags only the sessions that carry an old option and not its new one', async () => {
    stdout = ['perch-a|:|0|:|claude --x', 'perch-b|:|1|:|claude', 'perch-c|:|0|:|'].join('\n');
    expect(await new TmuxAdapter().retagLegacyOptions()).toBe(3);
    expect(calls.filter((args) => args[0] === 'list-sessions').map((args) => args[2])).toEqual([
      '#{session_name}|:|#{?@tarfa_command,1,0}|:|#{@perch_command}',
      '#{session_name}|:|#{?@tarfa_parent,1,0}|:|#{@perch_parent}',
      '#{session_name}|:|#{?@tarfa_codex_thread,1,0}|:|#{@perch_codex_thread}',
    ]);
    expect(calls.filter((args) => args[0] === 'set-option')).toEqual([
      ['set-option', '-t', '=perch-a:', '@tarfa_command', 'claude --x'],
      ['set-option', '-t', '=perch-a:', '@tarfa_parent', 'claude --x'],
      ['set-option', '-t', '=perch-a:', '@tarfa_codex_thread', 'claude --x'],
    ]);
  });

  it('runs the tmux binary it was given', async () => {
    await new TmuxAdapter({ binary: '/opt/tmux/bin/tmux' }).listSessions('perch-');
    expect(binaries.at(-1)).toBe('/opt/tmux/bin/tmux');
  });

  it('sets @tarfa_parent on a new session only when given one', async () => {
    const adapter = new TmuxAdapter();
    await adapter.createSession({ name: 'perch-c', cwd: '/w', command: 'claude', parent: 'perch-p' });
    expect(calls).toContainEqual(['set-option', '-t', '=perch-c:', '@tarfa_parent', 'perch-p']);
    calls.length = 0;
    await adapter.createSession({ name: 'perch-d', cwd: '/w', command: 'claude' });
    expect(calls.some((args) => args.includes('@tarfa_parent'))).toBe(false);
  });

  it('sets @tarfa_codex_thread on a new session only when given one', async () => {
    const adapter = new TmuxAdapter();
    await adapter.createSession({ name: 'perch-c', cwd: '/w', command: 'codex resume th-1', codexThread: 'th-1' });
    expect(calls).toContainEqual(['set-option', '-t', '=perch-c:', '@tarfa_codex_thread', 'th-1']);
    calls.length = 0;
    await adapter.createSession({ name: 'perch-d', cwd: '/w', command: 'claude' });
    expect(calls.some((args) => args.includes('@tarfa_codex_thread'))).toBe(false);
  });
});

describe('TmuxAdapter (spawn and peek arguments)', () => {
  it('stores a separate command as @tarfa_command when given one', async () => {
    await new TmuxAdapter().createSession({ name: 'perch-c', cwd: '/w', command: 'X=1 claude "$(cat f)"', storedCommand: 'claude' });
    expect(calls[0]).toEqual(['new-session', '-d', '-s', 'perch-c', '-c', '/w', 'X=1 claude "$(cat f)"']);
    expect(calls).toContainEqual(['set-option', '-t', '=perch-c:', '@tarfa_command', 'claude']);
  });

  it('sets the pane title', async () => {
    await new TmuxAdapter().setPaneTitle('perch-c', '✳ story #S');
    expect(calls).toEqual([['select-pane', '-t', '=perch-c:', '-T', '✳ story ##S']]);
  });

  it('captures the pane joined, from N lines of history', async () => {
    stdout = 'a\nb\n';
    expect(await new TmuxAdapter().capturePane('perch-c', 40)).toBe('a\nb\n');
    expect(calls).toEqual([['capture-pane', '-p', '-J', '-t', '=perch-c:', '-S', '-40']]);
  });

  it('names the session of a pane with a targeted display-message', async () => {
    stdout = 'perch-p\n';
    expect(await new TmuxAdapter().sessionOfPane('%12')).toBe('perch-p');
    expect(calls).toEqual([['display-message', '-p', '-t', '%12', '#S']]);
  });

  it('reads the pid of a pane by its id, targeted at that pane', async () => {
    stdout = '4321\n';
    expect(await new TmuxAdapter().pidOfPane('%12')).toBe(4321);
    expect(calls).toEqual([['display-message', '-p', '-t', '%12', '#{pane_pid}']]);
  });

  it("names a session's first pane across all its windows", async () => {
    stdout = '%4\n%9\n';
    expect(await new TmuxAdapter().firstPaneId('perch-c')).toBe('%4');
    expect(calls).toEqual([['list-panes', '-s', '-t', '=perch-c:', '-F', '#{pane_id}']]);
  });

  it('prepends -S <socket> to every call when given a socket', async () => {
    const adapter = new TmuxAdapter({ socket: '/s/sock' });
    await adapter.listSessions('perch-');
    await adapter.hasSession('perch-c');
    await adapter.setPaneTitle('perch-c', 't');
    for (const args of calls) expect(args.slice(0, 2)).toEqual(['-S', '/s/sock']);
  });
});
