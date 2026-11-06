import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { installHooks } from '../application/install-hooks';
import { fsIsDirectory } from './fs-directory-checker';
import { LEGACY_STATE_DIR, STATE_DIR, resolveStateDir } from './state-dir';

const SCRIPTS = ['tarfa-hook.sh', 'tarfa-guard.sh'];
const HOOK_COMMAND = 'bash ~/.tarfa/tarfa-hook.sh';
const GUARD_COMMAND = 'bash ~/.tarfa/tarfa-guard.sh';

// Claude Code rewrites its settings with sorted keys and other whitespace, and install-hooks
// re-appends Tarfa's entries after the user's own, so the same hooks can be spelled several ways:
// compared with keys sorted and each event's entries in any order.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameHooks(current: string, wanted: string): boolean {
  const canonical = (text: string) => {
    const settings = JSON.parse(text) as { hooks?: Record<string, unknown[]> };
    const hooks = Object.fromEntries(Object.entries(settings.hooks ?? {}).map(([event, entries]) => [event, entries.map(stable).sort()]));
    return stable({ ...settings, hooks });
  };
  return canonical(current) === canonical(wanted);
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// The hook scripts are copied to a stable, $HOME-relative place so the registered command is
// byte-identical across machines (the checkout lives at different paths), and copied rather than
// linked so it never goes stale if the checkout moves. Codex gets the same hooks only where it
// is installed, so a machine without it does not grow a ~/.codex.
export function hooksFiles(home: string, hooksDir: string, port: number) {
  const settingsPath = join(home, '.claude', 'settings.json');
  const codexDir = join(home, '.codex');
  const codexHooksPath = join(codexDir, 'hooks.json');

  async function wanted(): Promise<Array<{ path: string; current: string | null; text: string; mode?: number }>> {
    const files: Array<{ path: string; current: string | null; text: string; mode?: number }> = [];
    for (const script of SCRIPTS) {
      const path = join(home, STATE_DIR, script);
      files.push({ path, current: await readOrNull(path), text: await readFile(join(hooksDir, script), 'utf8'), mode: 0o755 });
    }
    const settings = await readOrNull(settingsPath);
    const merged = installHooks({ settings: settings === null ? {} : (JSON.parse(settings) as Record<string, unknown>) }, { hookCommand: HOOK_COMMAND, guardCommand: GUARD_COMMAND, port });
    files.push({ path: settingsPath, current: settings, text: JSON.stringify(merged, null, 2) });
    if (await fsIsDirectory(codexDir)) {
      const codex = await readOrNull(codexHooksPath);
      const codexMerged = installHooks(
        { settings: codex === null ? {} : (JSON.parse(codex) as Record<string, unknown>) },
        { hookCommand: HOOK_COMMAND, guardCommand: GUARD_COMMAND, port, agent: 'codex' },
      );
      files.push({ path: codexHooksPath, current: codex, text: JSON.stringify(codexMerged, null, 2) });
    }
    return files;
  }

  return {
    scriptPath: join(home, STATE_DIR, 'tarfa-hook.sh'),
    settingsPath,
    codexHooksPath,
    // Whether installing would change nothing.
    async current(): Promise<boolean> {
      return (await wanted()).every((file) =>
        file.mode !== undefined ? file.current === file.text : file.current !== null && sameHooks(file.current, file.text),
      );
    },
    // Returns whether Codex's hooks were written too.
    async install(): Promise<{ codex: boolean }> {
      // The commands name ~/.tarfa: written before the agent moved ~/.perch there, the scripts
      // would land in a directory the move then refuses to merge with.
      if (resolveStateDir(home) !== join(home, STATE_DIR)) {
        throw new Error(`~/${LEGACY_STATE_DIR} has not moved to ~/${STATE_DIR} yet: restart the agent (it moves it at startup) or run tarfa setup, then install the hooks`);
      }
      const files = await wanted();
      for (const file of files) {
        await mkdir(dirname(file.path), { recursive: true });
        if (file.mode !== undefined) {
          await copyFile(join(hooksDir, file.path.split('/').at(-1)!), file.path);
          await chmod(file.path, file.mode);
        } else {
          await writeFile(file.path, file.text, 'utf8');
        }
      }
      return { codex: files.some((file) => file.path === codexHooksPath) };
    },
  };
}
