import { describe, it, expect } from 'vitest';
import { ShortWorkspaceIds, createWithFreshId, workspaceSlug } from './short-workspace-ids';
import { DuplicateSessionError } from '../ports/tmux-port';
import type { ParkedWorkspace } from '../ports/parked-store-port';

describe('workspaceSlug', () => {
  it('is the folder name, lowercased', () => {
    expect(workspaceSlug('/home/u/workspace/Tarfa')).toBe('tarfa');
  });

  it('keeps only characters safe in a tmux name, a --name and an unquoted command', () => {
    expect(workspaceSlug('/w/v-kool.me')).toBe('v-kool-me');
    expect(workspaceSlug('/w/my project: notes')).toBe('my-project-notes');
    expect(workspaceSlug('/w/odoo_18')).toBe('odoo_18');
  });

  it('drops leading dots and dashes, so a dotfiles folder still reads', () => {
    expect(workspaceSlug('/home/u/.config')).toBe('config');
  });

  // `<workspace id>__<name>` is how a browser session names its workspace.
  it('never holds a double underscore', () => {
    expect(workspaceSlug('/w/my__proj')).toBe('my_proj');
    expect(workspaceSlug('/w/x_')).toBe('x');
  });

  it('caps a long folder name', () => {
    expect(workspaceSlug(`/w/${'a'.repeat(40)}`)).toBe('a'.repeat(20));
  });

  it('falls back when nothing usable is left', () => {
    expect(workspaceSlug('/')).toBe('ws');
    expect(workspaceSlug('/w/مشروع')).toBe('ws');
  });
});

function ids(
  taken: { tmux?: string[] | Set<string>; parked?: string[]; status?: string[]; addresses?: string[]; liveParent?: string; parkedParent?: string } = {},
) {
  return new ShortWorkspaceIds({
    tmux: {
      hasSession: async (name) => [...(taken.tmux ?? [])].includes(name),
      listSessions: async () =>
        taken.liveParent ? [{ name: 'perch-child', startPath: '/w', command: 'claude', createdAt: 1, title: '', parent: taken.liveParent }] : [],
    },
    sessionPrefix: 'perch-',
    parked: {
      list: async () => [
        ...(taken.parked ?? []).map((id) => ({ id }) as ParkedWorkspace),
        ...(taken.parkedParent ? [{ id: 'perch-pchild', parent: taken.parkedParent } as ParkedWorkspace] : []),
      ],
    },
    status: { ids: () => taken.status ?? [] },
    claudeSessions: {
      addressesByTmuxSession: async () => Object.fromEntries((taken.addresses ?? []).map((a, i) => [`s${i}`, a])),
      inboxOf: async () => null,
    },
  });
}

describe('ShortWorkspaceIds', () => {
  it('starts each folder at 1', async () => {
    expect(await ids().next('/w/perch')).toBe('perch-1');
  });

  it('takes the smallest number nothing holds', async () => {
    expect(await ids({ tmux: ['perch-1', 'perch-3'] }).next('/w/perch')).toBe('perch-2');
  });

  it('skips a parked workspace, which comes back under its id', async () => {
    expect(await ids({ parked: ['perch-1'] }).next('/w/perch')).toBe('perch-2');
  });

  it('skips an id the status store still holds, so nothing stale is inherited', async () => {
    expect(await ids({ status: ['perch-1'] }).next('/w/perch')).toBe('perch-2');
  });

  it("skips a live Claude session's address, so a message never reaches two sessions", async () => {
    expect(await ids({ addresses: ['perch-1'] }).next('/w/perch')).toBe('perch-2');
  });

  // A live or parked child still messages its parent's id: a new workspace must not take it.
  it("skips an id a child still names as its parent, live or parked", async () => {
    expect(await ids({ liveParent: 'perch-1' }).next('/w/perch')).toBe('perch-2');
    expect(await ids({ parkedParent: 'perch-1' }).next('/w/perch')).toBe('perch-2');
  });

  it('counts per folder', async () => {
    expect(await ids({ tmux: ['perch-1'] }).next('/w/eng-ops')).toBe('eng-ops-1');
  });
});

describe('createWithFreshId', () => {
  // Two creates into one folder at once both see perch-1 free; tmux lets only one have it.
  it('asks again when another create took the id first', async () => {
    const live = new Set<string>();
    const withLive = ids({ tmux: live });
    let first = true;
    const id = await createWithFreshId(withLive, '/w/perch', async (candidate) => {
      if (first) {
        first = false;
        live.add(candidate);
        throw new DuplicateSessionError(candidate);
      }
      live.add(candidate);
    });
    expect(id).toBe('perch-2');
  });

  it('passes any other failure through, and gives up after a few duplicates', async () => {
    await expect(createWithFreshId(ids(), '/w/perch', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    let tries = 0;
    await expect(
      createWithFreshId(ids(), '/w/perch', async (id) => {
        tries++;
        throw new DuplicateSessionError(id);
      }),
    ).rejects.toThrow(DuplicateSessionError);
    expect(tries).toBe(5);
  });
});
