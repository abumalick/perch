import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectInstalled, loginShellResolver } from './installed-detector';

describe('detectInstalled', () => {
  it('keeps the names the resolver finds, in order', async () => {
    expect(await detectInstalled(['claude', 'codex'], async (n) => n === 'codex')).toEqual(['codex']);
    expect(await detectInstalled(['claude', 'codex'], async () => true)).toEqual(['claude', 'codex']);
    expect(await detectInstalled(['claude', 'codex'], async () => false)).toEqual([]);
  });
});

describe('loginShellResolver', () => {
  const resolve = loginShellResolver();
  it('finds a binary on the PATH', async () => expect(await resolve('ls')).toBe(true));
  it('does not find an absent one', async () => expect(await resolve('perch-no-such-cli-xyz')).toBe(false));
});

describe('loginShellResolver when the lookup itself is unreliable', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'perch-shell-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  async function shellExiting(code: number): Promise<string> {
    const path = join(dir, `sh-${code}`);
    await writeFile(path, `#!/bin/sh\nexit ${code}\n`);
    await chmod(path, 0o755);
    return path;
  }

  it('reads exit 1 as "not installed"', async () => {
    expect(await loginShellResolver(await shellExiting(1))('claude')).toBe(false);
  });

  it('keeps the CLI offered when the shell itself fails (a broken profile, a timeout)', async () => {
    expect(await loginShellResolver(await shellExiting(2))('claude')).toBe(true);
  });

  it('keeps the CLI offered when the shell cannot be started', async () => {
    expect(await loginShellResolver(join(dir, 'missing'))('claude')).toBe(true);
  });
});
