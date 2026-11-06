import { describe, it, expect, vi } from 'vitest';
import { reconcileParked } from './reconcile-parked';
import type { ParkedWorkspace } from '../ports/parked-store-port';

const record = (id: string): ParkedWorkspace => ({
  id,
  name: 'Parked',
  projectPath: '/home/u/workspace/foo',
  command: 'claude',
  machineId: 'dev',
  createdAt: 1,
  parkedAt: 2,
  claudeSessionId: 'sess-1',
});

const tmuxWith = (names: string[], killSession = vi.fn(async () => {})) => ({
  hasSession: async (name: string) => names.includes(name),
  killSession,
});

describe('reconcileParked', () => {
  it('kills a tmux session that collides with a parked record', async () => {
    // tmux-continuum restores session names (not the claude process) when the tmux server
    // starts, resurrecting a parked id as an empty shell. The record wins — otherwise the
    // shell would shadow it and its claudeSessionId would be lost.
    const tmux = tmuxWith(['perch-a']);
    const killed = await reconcileParked({ parked: { list: async () => [record('perch-a')] }, tmux });
    expect(killed).toEqual(['perch-a']);
    expect(tmux.killSession).toHaveBeenCalledWith('perch-a');
  });

  // The resurrected shell has no `@tarfa_command`, so a short id is found by name alone.
  it('kills a colliding session whatever its id looks like', async () => {
    const tmux = tmuxWith(['eng-ops-1']);
    const killed = await reconcileParked({ parked: { list: async () => [record('eng-ops-1')] }, tmux });
    expect(killed).toEqual(['eng-ops-1']);
  });

  it('leaves live sessions with no parked record alone', async () => {
    const tmux = tmuxWith(['perch-other']);
    const killed = await reconcileParked({ parked: { list: async () => [record('perch-a')] }, tmux });
    expect(killed).toEqual([]);
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it('does nothing when there are no parked records', async () => {
    const tmux = tmuxWith(['perch-a']);
    const killed = await reconcileParked({ parked: { list: async () => [] }, tmux });
    expect(killed).toEqual([]);
    expect(tmux.killSession).not.toHaveBeenCalled();
  });
});
