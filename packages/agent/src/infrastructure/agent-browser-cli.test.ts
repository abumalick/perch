import { describe, it, expect, vi } from 'vitest';
import { AgentBrowserCli, execFileRunner } from './agent-browser-cli';

function makeRunner() {
  return vi.fn<(cmd: string, args: string[], env: Record<string, string> | null) => Promise<void>>(
    async () => undefined,
  );
}

const noDaemon = async () => null;

describe('AgentBrowserCli', () => {
  it('start opens about:blank with the inherited env when no daemon is running, then sets a phone viewport', async () => {
    const run = makeRunner();
    const cli = new AgentBrowserCli(run, noDaemon);

    await cli.start('ws1');

    expect(run).toHaveBeenCalledTimes(2);
    const [cmd, args, env] = run.mock.calls[0]!;
    expect(cmd).toBe('agent-browser');
    expect(args).toEqual(['--session', 'ws1', 'open', 'about:blank']);
    expect(env).toBeNull();
    // Phone-sized viewport → ~1:1 canvas scale on the phone, so taps land precisely.
    expect(run.mock.calls[1]![1]).toEqual(['--session', 'ws1', 'set', 'viewport', '390', '700']);
  });

  // agent-browser relaunches a session whose launch config differs from the one it was created
  // with, so every command carries that session's own launch env.
  it('every command replays the launch env of the session it targets', async () => {
    const run = makeRunner();
    const launchEnv = vi.fn(async (session: string) =>
      session === 'ws__g' ? { AGENT_BROWSER_PROFILE: '/p', DISPLAY: ':99' } : null,
    );
    const cli = new AgentBrowserCli(run, launchEnv);

    await cli.setViewport('ws__g', 390, 700);
    await cli.navigate('ws__g', 'https://example.com/');
    await cli.back('other');

    expect(run.mock.calls.map((c) => c[2])).toEqual([
      { AGENT_BROWSER_PROFILE: '/p', DISPLAY: ':99' },
      { AGENT_BROWSER_PROFILE: '/p', DISPLAY: ':99' },
      null,
    ]);
  });

  it('start still succeeds when the viewport step fails', async () => {
    const run = makeRunner().mockImplementation(async (_cmd, args) => {
      if (args.includes('viewport')) throw new Error('unsupported');
    });
    const cli = new AgentBrowserCli(run, noDaemon);

    await expect(cli.start('ws1')).resolves.toBeUndefined();
  });

  it('navigate passes the URL as a single argv element', async () => {
    const run = makeRunner();
    const cli = new AgentBrowserCli(run, noDaemon);

    await cli.navigate('ws1', 'https://example.com/a b?q=1&r=2');

    expect(run).toHaveBeenCalledTimes(1);
    const [cmd, args, env] = run.mock.calls[0]!;
    expect(cmd).toBe('agent-browser');
    expect(args).toEqual(['--session', 'ws1', 'open', 'https://example.com/a b?q=1&r=2']);
    expect(env).toBeNull();
  });

  it('navigate accepts plain http URLs', async () => {
    const run = makeRunner();
    const cli = new AgentBrowserCli(run, noDaemon);

    await cli.navigate('ws1', 'http://127.0.0.1:8080/');

    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['back', ['--session', 'ws1', 'back']],
    ['forward', ['--session', 'ws1', 'forward']],
    ['stop', ['--session', 'ws1', 'close']],
  ] as const)('%s runs the matching CLI subcommand with the inherited env when no daemon is running', async (method, expectedArgs) => {
    const run = makeRunner();
    const cli = new AgentBrowserCli(run, noDaemon);

    await cli[method]('ws1');

    expect(run).toHaveBeenCalledTimes(1);
    const [cmd, args, env] = run.mock.calls[0]!;
    expect(cmd).toBe('agent-browser');
    expect(args).toEqual(expectedArgs);
    expect(env).toBeNull();
  });

  it('setViewport passes rounded dimensions with the inherited env when no daemon is running', async () => {
    const run = makeRunner();
    const cli = new AgentBrowserCli(run, noDaemon);

    await cli.setViewport('ws1', 390.4, 843.6);

    expect(run).toHaveBeenCalledTimes(1);
    const [cmd, args, env] = run.mock.calls[0]!;
    expect(cmd).toBe('agent-browser');
    expect(args).toEqual(['--session', 'ws1', 'set', 'viewport', '390', '844']);
    expect(env).toBeNull();
  });

  it.each([
    [100, 700, ['200', '700']],
    [390, 9000, ['390', '4096']],
  ])('setViewport clamps %d×%d into [200, 4096]', async (w, h, expected) => {
    const run = makeRunner();
    const cli = new AgentBrowserCli(run, noDaemon);

    await cli.setViewport('ws1', w, h);

    expect(run.mock.calls[0]![1]).toEqual(['--session', 'ws1', 'set', 'viewport', ...expected]);
  });

  it.each([
    [Number.NaN, 700],
    [390, Number.POSITIVE_INFINITY],
  ])('setViewport rejects non-finite dimensions %d×%d without invoking the runner', async (w, h) => {
    const run = makeRunner();
    const cli = new AgentBrowserCli(run, noDaemon);

    await expect(cli.setViewport('ws1', w, h)).rejects.toThrow(/finite/);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://example.com/x',
    'not a url',
    '',
    'example.com', // no scheme — does not parse as a URL
  ])('navigate rejects %j without invoking the runner', async (url) => {
    const run = makeRunner();
    const cli = new AgentBrowserCli(run, noDaemon);

    await expect(cli.navigate('ws1', url)).rejects.toThrow(/http/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('execFileRunner', () => {
  it('adds the launch env to the inherited env (services need PATH for the mise shim)', async () => {
    // A child that exits non-zero unless it sees both the overlay var and an
    // inherited PATH — proving the overlay extends process.env, not replaces it.
    await expect(
      execFileRunner(
        'node',
        ['-e', 'process.exit(process.env.PERCH_TEST_OVERLAY === "1" && process.env.PATH ? 0 : 1)'],
        { PERCH_TEST_OVERLAY: '1' },
      ),
    ).resolves.toBeUndefined();
  });

  it('replaces every inherited AGENT_BROWSER_* variable with the session launch env', async () => {
    process.env.AGENT_BROWSER_TEST_INHERITED = 'x';
    try {
      const check =
        'process.exit(process.env.AGENT_BROWSER_TEST_INHERITED === undefined ' +
        '&& process.env.AGENT_BROWSER_HEADED === "1" && process.env.PATH ? 0 : 1)';
      await expect(
        execFileRunner('node', ['-e', check], { AGENT_BROWSER_HEADED: '1' }),
      ).resolves.toBeUndefined();
      await expect(
        execFileRunner(
          'node',
          ['-e', 'process.exit(process.env.AGENT_BROWSER_TEST_INHERITED === "x" ? 0 : 1)'],
          null,
        ),
      ).resolves.toBeUndefined();
    } finally {
      delete process.env.AGENT_BROWSER_TEST_INHERITED;
    }
  });

  it('rejects when the command fails', async () => {
    await expect(execFileRunner('node', ['-e', 'process.exit(1)'], null)).rejects.toThrow();
  });
});
