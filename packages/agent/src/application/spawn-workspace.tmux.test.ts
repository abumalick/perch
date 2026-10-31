import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TmuxAdapter } from '../infrastructure/tmux-adapter';
import { FsFileWriter } from '../infrastructure/fs-file-writer';
import { fsResolveDirectory } from '../infrastructure/fs-directory-checker';
import { RandomIdGenerator } from '../infrastructure/system';
import { spawnWorkspace } from './spawn-workspace';

// ISOLATION: every tmux call here, the test's own and the adapter's, carries `-S <sandbox
// socket>`. -S beats $TMUX, which inside a Perch pane names the real server holding the user's
// workspaces; never call tmux here without it. The sandbox server also gets `-f /dev/null`, so
// the user's tmux plugins never run against it.
const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.tmp');

let sandbox: string;
let socket: string;
let out: string;
let launcher: string;
let project: string;

// Socket paths are capped near 108 bytes, so the names stay short.
beforeAll(async () => {
  await mkdir(ROOT, { recursive: true });
  sandbox = await mkdtemp(join(ROOT, 'sp-'));
  socket = join(sandbox, 's');
  out = join(sandbox, 'out');
  project = join(sandbox, 'project');
  launcher = join(sandbox, 'fake-claude');
  await mkdir(out);
  await mkdir(project);
  await writeFile(
    launcher,
    [
      '#!/bin/sh',
      `out='${out}'`,
      'rm -f "$out"/*',
      'i=0',
      'for a in "$@"; do i=$((i + 1)); printf \'%s\' "$a" > "$out/arg$i"; done',
      'printf \'%s\' "${CLAUDE_CODE_DISABLE_TERMINAL_TITLE-}" > "$out/title_env"',
      'printf \'%s\' "$#" > "$out/argc"',
      'exec sleep 30',
      '',
    ].join('\n'),
  );
  await chmod(launcher, 0o755);
});

afterAll(async () => {
  if (socket?.startsWith(`${sandbox}/`)) {
    await exec('tmux', ['-S', socket, 'kill-server']).catch(() => undefined);
  }
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

const t = (args: string[]) => exec('tmux', ['-S', socket, ...args]).then((r) => r.stdout.replace(/\n$/, ''));

async function launched(): Promise<string[]> {
  for (let i = 0; i < 100; i++) {
    const done = await stat(join(out, 'argc')).then(() => true, () => false);
    if (done) {
      const argc = Number(await readFile(join(out, 'argc'), 'utf8'));
      return Promise.all(Array.from({ length: argc }, (_, n) => readFile(join(out, `arg${n + 1}`), 'utf8')));
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the launcher never ran');
}

function sandboxEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // A Perch pane carries these; the sandbox server and its panes must not inherit them.
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE;
  return env;
}

describe('spawnWorkspace (real tmux, sandbox socket)', () => {
  it('hands the brief to the program byte for byte, as one argument', async () => {
    const tmux = new TmuxAdapter({ socket, config: '/dev/null', env: sandboxEnv() });
    const brief = 'Fix it.\nHostile: don\'t "quoted" `backtick` $x $(whoami) a|b; c>d & 100% \\n';
    const id = await spawnWorkspace(
      {
        tmux,
        files: new FsFileWriter(),
        resolveDirectory: fsResolveDirectory(sandbox),
        ids: new RandomIdGenerator(),
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 300))),
        spawnDir: join(sandbox, 'spawn'),
        launcher,
      },
      { projectPath: 'project', brief, title: 'story 9', parent: { id: 'perch-p00001', name: 'orch' } },
    );

    // Before anything else: the session is on the sandbox server, or the isolation failed.
    await expect(t(['has-session', '-t', id])).resolves.toBe('');

    const args = await launched();
    const settings = join(sandbox, 'spawn', `${id}.settings.json`);
    expect(args.slice(0, 6)).toEqual(['--model', 'opus[1m]', '--name', id, '--settings', settings]);
    expect(args).toHaveLength(7);
    expect(args[6]!.startsWith(`${brief}\n\n---\n`)).toBe(true);
    expect(await readFile(join(out, 'title_env'), 'utf8')).toBe('1');
    expect(await t(['display-message', '-p', '-t', id, '#{pane_title}'])).toBe('✳ story 9');
    expect(await t(['display-message', '-p', '-t', id, '#{session_path}'])).toBe(project);
    expect(await t(['show-options', '-t', id, '-v', '@perch_command'])).toBe(`${launcher} --model 'opus[1m]' --name ${id} --settings ${settings}`);
    expect(await t(['show-options', '-t', id, '-v', '@perch_parent'])).toBe('perch-p00001');

    const [listed] = await tmux.listSessions(id);
    expect(listed?.parent).toBe('perch-p00001');
    expect(await tmux.capturePane(id, 10)).toBeTypeOf('string');
    const pane = await t(['list-panes', '-t', id, '-F', '#{pane_id}']);
    expect(await tmux.sessionOfPane(pane)).toBe(id);
    expect(await tmux.sessionOfPane('%999999')).toBeNull();
  });
});
