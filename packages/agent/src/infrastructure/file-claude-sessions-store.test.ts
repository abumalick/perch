import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileClaudeSessionsStore } from './file-claude-sessions-store';

let dir: string;

const write = (pid: string, entry: unknown) =>
  writeFile(join(dir, `${pid}.json`), JSON.stringify(entry), 'utf8');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perch-claude-sessions-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileClaudeSessionsStore', () => {
  it('returns an empty map when the directory is missing', async () => {
    const store = new FileClaudeSessionsStore(join(dir, 'absent'));
    expect(await store.addressesByTmuxSession()).toEqual({});
  });

  it('maps each session tmux name to its address', async () => {
    await write('12345', { name: 'foo-cc', tmux: 'perch-aaa111:@1.%1' });
    await write('23456', { name: 'perch-be', tmux: 'perch-bbb222:@2.%2' });
    expect(await new FileClaudeSessionsStore(dir).addressesByTmuxSession()).toEqual({
      'perch-aaa111': 'foo-cc',
      'perch-bbb222': 'perch-be',
    });
  });

  // The registry is written by another process while we read it, so a half-written or
  // hand-corrupted file must cost that one entry rather than every workspace's address.
  it('skips an unparseable file and keeps the rest', async () => {
    await write('12345', { name: 'foo-cc', tmux: 'perch-aaa111:@1.%1' });
    await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8');
    expect(await new FileClaudeSessionsStore(dir).addressesByTmuxSession()).toEqual({
      'perch-aaa111': 'foo-cc',
    });
  });

  it('skips an entry with no tmux session to join on', async () => {
    await write('12345', { name: 'foo-cc', tmux: 'perch-aaa111:@1.%1' });
    await write('900001', { name: 'ran-outside-tmux', cwd: '/home/x' });
    expect(await new FileClaudeSessionsStore(dir).addressesByTmuxSession()).toEqual({
      'perch-aaa111': 'foo-cc',
    });
  });

  // Only the per-session json files are entries; the directory also holds `.key` files.
  it('ignores files that are not json', async () => {
    await write('12345', { name: 'foo-cc', tmux: 'perch-aaa111:@1.%1' });
    await writeFile(join(dir, '12345.abc123.key'), 'secret', 'utf8');
    expect(await new FileClaudeSessionsStore(dir).addressesByTmuxSession()).toEqual({
      'perch-aaa111': 'foo-cc',
    });
  });
});

describe('FileClaudeSessionsStore.inboxOf', () => {
  const sock = (pid: number) => `/run/user/1000/cc-socks/${pid}.sock`;
  const keyFile = (pid: number) =>
    join(dir, `${pid}.${createHash('sha256').update(sock(pid)).digest('hex')}.key`);
  const entry = (pid: number, tmux: string, extra: object = {}) =>
    write(String(pid), { pid, name: `n${pid}`, tmux, messagingSocketPath: sock(pid), peerProtocol: 1, ...extra });
  // Far above Linux's pid_max, so never alive.
  const DEAD = 99_999_999;

  it('picks the live pid whose tmux field names the session and reads its token', async () => {
    const live = process.pid;
    await entry(DEAD, 'perch-aaa111:@1.%1');
    await entry(live, 'perch-aaa111:@3.%3');
    await entry(live + 1, 'perch-bbb222:@2.%2');
    await writeFile(keyFile(live), JSON.stringify({ peerToken: 'abc123', procStart: '1', pidDomain: 'x' }), 'utf8');
    expect(await new FileClaudeSessionsStore(dir).inboxOf('perch-aaa111')).toEqual({
      socketPath: sock(live),
      peerProtocol: 1,
      token: 'abc123',
    });
  });

  it('returns the inbox without a token when the key file is missing', async () => {
    await entry(process.pid, 'perch-aaa111:@1.%1', { peerProtocol: 2 });
    expect(await new FileClaudeSessionsStore(dir).inboxOf('perch-aaa111')).toEqual({
      socketPath: sock(process.pid),
      peerProtocol: 2,
    });
  });

  it('returns null when only a dead session names the workspace', async () => {
    await entry(DEAD, 'perch-aaa111:@1.%1');
    expect(await new FileClaudeSessionsStore(dir).inboxOf('perch-aaa111')).toBeNull();
  });

  it('returns null when the directory is missing', async () => {
    expect(await new FileClaudeSessionsStore(join(dir, 'absent')).inboxOf('perch-aaa111')).toBeNull();
  });

  // pid 1 always exists (EPERM counts as alive), so three records can be live at once.
  it("prefers, among several live records, the one on the session's first pane", async () => {
    await entry(process.pid, 'perch-aaa111:@1.%1');
    await entry(process.ppid, 'perch-aaa111:@1.%7');
    expect(await new FileClaudeSessionsStore(dir).inboxOf('perch-aaa111', '%7')).toEqual({ socketPath: sock(process.ppid), peerProtocol: 1 });
  });

  // A `claude -p` run inside a session's Bash shares its pane, and both say `kind: "interactive"`;
  // only `entrypoint` tells them apart (`cli` against `sdk-cli`, measured on Claude Code 2.1.319).
  it('prefers the interactive session over a claude -p run on the same pane', async () => {
    await entry(process.pid, 'perch-aaa111:@1.%1', { kind: 'interactive', entrypoint: 'cli' });
    await entry(process.ppid, 'perch-aaa111:@1.%1', { kind: 'interactive', entrypoint: 'sdk-cli' });
    expect(await new FileClaudeSessionsStore(dir).inboxOf('perch-aaa111', '%1')).toEqual({ socketPath: sock(process.pid), peerProtocol: 1 });
  });

  it('prefers the interactive session over a claude -p run on the first pane', async () => {
    await entry(process.pid, 'perch-aaa111:@1.%2', { entrypoint: 'cli' });
    await entry(process.ppid, 'perch-aaa111:@1.%1', { entrypoint: 'sdk-cli' });
    expect(await new FileClaudeSessionsStore(dir).inboxOf('perch-aaa111', '%1')).toEqual({ socketPath: sock(process.pid), peerProtocol: 1 });
  });

  it('counts an entry that names no entrypoint as interactive', async () => {
    await entry(process.pid, 'perch-aaa111:@1.%1');
    await entry(process.ppid, 'perch-aaa111:@1.%1', { entrypoint: 'sdk-ts' });
    expect(await new FileClaudeSessionsStore(dir).inboxOf('perch-aaa111', '%1')).toEqual({ socketPath: sock(process.pid), peerProtocol: 1 });
  });

  it('still refuses two interactive sessions on the same pane', async () => {
    await entry(process.pid, 'perch-aaa111:@1.%1', { entrypoint: 'cli' });
    await entry(process.ppid, 'perch-aaa111:@1.%1', { entrypoint: 'cli' });
    expect(await new FileClaudeSessionsStore(dir).inboxOf('perch-aaa111', '%1')).toBe('ambiguous');
  });

  it('delivers to a claude -p run when nothing else is live there', async () => {
    await entry(process.pid, 'perch-aaa111:@1.%1', { entrypoint: 'sdk-cli' });
    expect(await new FileClaudeSessionsStore(dir).inboxOf('perch-aaa111', '%1')).toEqual({ socketPath: sock(process.pid), peerProtocol: 1 });
  });

  it('refuses to pick when several live records name the session and none, or more than one, is on its first pane', async () => {
    await entry(process.pid, 'perch-aaa111:@1.%1');
    await entry(process.ppid, 'perch-aaa111:@2.%2');
    expect(await new FileClaudeSessionsStore(dir).inboxOf('perch-aaa111', '%9')).toBe('ambiguous');
    expect(await new FileClaudeSessionsStore(dir).inboxOf('perch-aaa111', null)).toBe('ambiguous');
    await entry(1, 'perch-aaa111:@1.%1');
    expect(await new FileClaudeSessionsStore(dir).inboxOf('perch-aaa111', '%1')).toBe('ambiguous');
  });

  it('takes a single live record whatever pane it is on', async () => {
    await entry(process.pid, 'perch-aaa111:@2.%5');
    expect(await new FileClaudeSessionsStore(dir).inboxOf('perch-aaa111', '%1')).toEqual({ socketPath: sock(process.pid), peerProtocol: 1 });
  });

  it('does not match a session whose name merely starts with the id', async () => {
    await entry(process.pid, 'perch-aaa1110:@1.%1');
    expect(await new FileClaudeSessionsStore(dir).inboxOf('perch-aaa111')).toBeNull();
  });
});
