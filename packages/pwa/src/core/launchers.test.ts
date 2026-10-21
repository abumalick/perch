import { describe, it, expect } from 'vitest';
import { buildLauncherOptions } from './launchers';

const ids = (r: Parameters<typeof buildLauncherOptions>[0]) => buildLauncherOptions(r).map((o) => o.id);

describe('buildLauncherOptions', () => {
  it('offers the fixed list until the agent has answered', () => {
    expect(ids(undefined)).toEqual(['claude', 'codex', 'bash']);
  });

  it('offers Bash alone when nothing is detected', () => {
    expect(ids({ detected: [], custom: [] })).toEqual(['bash']);
  });

  it('puts Claude before Codex whatever order they were detected in', () => {
    expect(ids({ detected: ['codex', 'claude'], custom: [] })).toEqual(['claude', 'codex', 'bash']);
  });

  it('appends custom commands after Bash, removable and without models', () => {
    const options = buildLauncherOptions({ detected: ['claude'], custom: ['pi', 'zsh'] });
    expect(options.map((o) => o.label)).toEqual(['Claude', 'Bash', 'pi', 'zsh']);
    expect(options.filter((o) => o.removable).map((o) => o.base)).toEqual(['pi', 'zsh']);
    expect(options.at(-1)?.models).toEqual([]);
  });

  it('keeps Opus first for Claude and the Codex daemon flag', () => {
    const options = buildLauncherOptions({ detected: ['claude', 'codex'], custom: [] });
    expect(options[0]?.models[0]?.value).toBe('opus[1m]');
    expect(options[1]?.base).toBe('codex --no-daemon');
  });
});
