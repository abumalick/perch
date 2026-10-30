import { describe, it, expect, vi, beforeEach } from 'vitest';

// No tmux server is touched here: execFile is replaced, so these check the arguments the adapter
// sends and how it parses tmux's answer.
const calls: string[][] = [];
let stdout = '';
vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, args: string[], _opts: unknown, cb: (err: null, res: { stdout: string; stderr: string }) => void) => {
    calls.push(args);
    cb(null, { stdout, stderr: '' });
  },
}));

const { TmuxAdapter } = await import('./tmux-adapter');

beforeEach(() => {
  calls.length = 0;
  stdout = '';
});

describe('TmuxAdapter (arguments)', () => {
  it('reads @perch_parent before the pane title, which stays last', async () => {
    await new TmuxAdapter().listSessions('perch-');
    const fields = calls[0]![2]!.split('|:|');
    expect(fields.at(-2)).toBe('#{@perch_parent}');
    expect(fields.at(-1)).toBe('#{pane_title}');
  });

  it('parses a parent, and omits an empty one', async () => {
    stdout = [
      'perch-a|:|/w|:|10|:|claude|:|perch-p|:|a|:|title',
      'perch-b|:|/w|:|10|:|claude|:||:|plain',
    ].join('\n');
    const [a, b] = await new TmuxAdapter().listSessions('perch-');
    expect(a).toEqual({ name: 'perch-a', startPath: '/w', command: 'claude', createdAt: 10_000, parent: 'perch-p', title: 'a|:|title' });
    expect(b).toEqual({ name: 'perch-b', startPath: '/w', command: 'claude', createdAt: 10_000, title: 'plain' });
  });

  it('sets @perch_parent on a new session only when given one', async () => {
    const adapter = new TmuxAdapter();
    await adapter.createSession({ name: 'perch-c', cwd: '/w', command: 'claude', parent: 'perch-p' });
    expect(calls).toContainEqual(['set-option', '-t', 'perch-c', '@perch_parent', 'perch-p']);
    calls.length = 0;
    await adapter.createSession({ name: 'perch-d', cwd: '/w', command: 'claude' });
    expect(calls.some((args) => args.includes('@perch_parent'))).toBe(false);
  });
});

describe('TmuxAdapter (spawn and peek arguments)', () => {
  it('stores a separate command as @perch_command when given one', async () => {
    await new TmuxAdapter().createSession({ name: 'perch-c', cwd: '/w', command: 'X=1 claude "$(cat f)"', storedCommand: 'claude' });
    expect(calls[0]).toEqual(['new-session', '-d', '-s', 'perch-c', '-c', '/w', 'X=1 claude "$(cat f)"']);
    expect(calls).toContainEqual(['set-option', '-t', 'perch-c', '@perch_command', 'claude']);
  });

  it('sets the pane title', async () => {
    await new TmuxAdapter().setPaneTitle('perch-c', '✳ story');
    expect(calls).toEqual([['select-pane', '-t', 'perch-c', '-T', '✳ story']]);
  });

  it('captures the pane joined, from N lines of history', async () => {
    stdout = 'a\nb\n';
    expect(await new TmuxAdapter().capturePane('perch-c', 40)).toBe('a\nb\n');
    expect(calls).toEqual([['capture-pane', '-p', '-J', '-t', 'perch-c', '-S', '-40']]);
  });

  it('names the session of a pane with a targeted display-message', async () => {
    stdout = 'perch-p\n';
    expect(await new TmuxAdapter().sessionOfPane('%12')).toBe('perch-p');
    expect(calls).toEqual([['display-message', '-p', '-t', '%12', '#S']]);
  });

  it('prepends -S <socket> to every call when given a socket', async () => {
    const adapter = new TmuxAdapter({ socket: '/s/sock' });
    await adapter.listSessions('perch-');
    await adapter.hasSession('perch-c');
    await adapter.setPaneTitle('perch-c', 't');
    for (const args of calls) expect(args.slice(0, 2)).toEqual(['-S', '/s/sock']);
  });
});
