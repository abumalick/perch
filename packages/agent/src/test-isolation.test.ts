import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// The guard for test-sandbox.test-support.ts: if these fail, a test session could land on the
// machine's real tmux server, where a running agent would list it and log it as closed, or a
// default path could reach the real ~/.tarfa.
describe('the agent test sandbox', () => {
  it('points the home directory away from the real one', () => {
    // userInfo reads the passwd entry, which HOME does not change.
    expect(homedir()).not.toBe(userInfo().homedir);
  });

  it('points bare tmux calls at a server of its own', async () => {
    expect(process.env.TMUX).toBeUndefined();
    expect(process.env.TMUX_PANE).toBeUndefined();
    const { stdout } = await exec('tmux', ['display-message', '-p', '#{socket_path}']);
    // Measured against the sandbox HOME's parent: a TMUX_TMPDIR the sandbox did not set proves nothing.
    expect(stdout.trim().startsWith(join(realpathSync(dirname(homedir())), 'tmux-'))).toBe(true);
  });
});
