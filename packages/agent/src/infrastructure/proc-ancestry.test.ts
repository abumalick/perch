import { describe, it, expect } from 'vitest';
import { ProcAncestry, procParentOf, psParentOf } from './proc-ancestry';

describe('ProcAncestry', () => {
  const ancestry = new ProcAncestry();

  it('finds this process under its parent, and not the other way round', async () => {
    expect(await ancestry.isAncestor(process.ppid, process.pid)).toBe(true);
    expect(await ancestry.isAncestor(process.pid, process.ppid)).toBe(false);
  });

  it('a process is not its own ancestor', async () => {
    expect(await ancestry.isAncestor(process.pid, process.pid)).toBe(false);
  });

  it('a pid that does not exist has no ancestors', async () => {
    expect(await ancestry.isAncestor(process.pid, 2 ** 22 + 12345)).toBe(false);
  });

  // A fake chain: 10 → 9 → … → 2 → 1.
  const chain = (pid: number) => Promise.resolve(pid > 1 ? pid - 1 : 0);

  it('walks up through every generation, and stops at init', async () => {
    const fake = new ProcAncestry(chain);
    expect(await fake.isAncestor(2, 10)).toBe(true);
    expect(await fake.isAncestor(11, 10)).toBe(false);
  });

  it('stops at a pid it cannot read', async () => {
    const fake = new ProcAncestry(async (pid) => (pid === 5 ? null : pid - 1));
    expect(await fake.isAncestor(3, 10)).toBe(false);
  });

  it('gives up after 64 generations', async () => {
    const fake = new ProcAncestry(chain);
    expect(await fake.isAncestor(1000 - 64, 1000)).toBe(true);
    expect(await fake.isAncestor(1000 - 65, 1000)).toBe(false);
  });

  it('reads a parent whose command name holds spaces and parentheses', async () => {
    expect(await procParentOf(process.pid)).toBe(process.ppid);
    expect(await procParentOf(1, async () => '1 (tmux: server) (x) S 4242 1 1 0')).toBe(4242);
    expect(await procParentOf(1, async () => { throw new Error('ENOENT'); })).toBeNull();
  });

  it('asks ps where there is no /proc', async () => {
    expect(await psParentOf(process.pid)).toBe(process.ppid);
    expect(await psParentOf(2 ** 22 + 12345)).toBeNull();
  });
});
