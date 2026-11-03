import { describe, it, expect } from 'vitest';
import { renameWorkspace } from './rename-workspace';
import type { ParkedWorkspace } from '../ports/parked-store-port';

function fakes(opts: { live?: string[]; parked?: string[]; lock?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      tmux: {
        hasSession: async (name: string) => (opts.live ?? ['perch-3']).includes(name),
        setPaneTitle: async (name: string, title: string) => void calls.push(`title ${name} ${title}`),
        supportsTitleLock: async () => opts.lock ?? true,
        lockPaneTitle: async (name: string) => void calls.push(`lock ${name}`),
      },
      parked: {
        get: async (id: string) => ((opts.parked ?? []).includes(id) ? ({ id } as ParkedWorkspace) : undefined),
      },
    },
  };
}

describe('renameWorkspace', () => {
  // The lock comes first, or Claude could write its own title between the two calls.
  it('locks the pane title, then sets it with the glyph deriveWorkspaceName trusts', async () => {
    const f = fakes();
    expect(await renameWorkspace(f.deps, 'perch-3', '  Invoice PDF fix ')).toEqual({ locked: true });
    expect(f.calls).toEqual(['lock perch-3', 'title perch-3 ✳ Invoice PDF fix']);
  });

  it('still sets the title where tmux cannot lock it, and says so', async () => {
    const f = fakes({ lock: false });
    expect(await renameWorkspace(f.deps, 'perch-3', 'x')).toEqual({ locked: false });
    expect(f.calls).toEqual(['title perch-3 ✳ x']);
  });

  it('refuses an empty title', async () => {
    await expect(renameWorkspace(fakes().deps, 'perch-3', '   ')).rejects.toThrow(/empty/);
  });

  // The title is the last field of a `list-sessions` line, so a newline would split it.
  it('refuses control characters', async () => {
    await expect(renameWorkspace(fakes().deps, 'perch-3', 'a\nb')).rejects.toThrow(/control/);
  });

  it('refuses a parked workspace, whose name comes back from its record', async () => {
    const f = fakes({ live: [], parked: ['perch-3'] });
    await expect(renameWorkspace(f.deps, 'perch-3', 'x')).rejects.toThrow(/parked/);
    expect(f.calls).toEqual([]);
  });

  it('refuses an unknown workspace', async () => {
    await expect(renameWorkspace(fakes({ live: [] }).deps, 'perch-9', 'x')).rejects.toThrow(/no workspace perch-9/);
  });
});
