// Perch workspace ids as `perch ls` and `perch spawn` print them.
const WORKSPACE_ID = /\bperch-[0-9a-f]{6}\b/g;

export interface TerminalCell {
  chars: string;
  width: number;
}

export interface WorkspaceIdMatch {
  id: string;
  /** 0-based cell columns, end inclusive. */
  startCol: number;
  endCol: number;
}

// A cell's text can be several UTF-16 units (an emoji) and a wide character's second cell is
// empty, so a string index is not a column; record the column of every unit of the line text.
export function findWorkspaceIds(cells: readonly TerminalCell[]): WorkspaceIdMatch[] {
  let text = '';
  const columns: number[] = [];
  cells.forEach((cell, col) => {
    if (cell.width === 0) return;
    const chars = cell.chars || ' ';
    text += chars;
    for (let i = 0; i < chars.length; i++) columns.push(col);
  });
  return [...text.matchAll(WORKSPACE_ID)].map((m) => ({
    id: m[0],
    startCol: columns[m.index]!,
    endCol: columns[m.index + m[0].length - 1]!,
  }));
}

// The workspace a tapped id opens. Ids are only unique per machine, so the caller's machine wins
// a tie. A parked one is left out: opening it unparks it and starts Claude, too much for a tap
// that can land by accident on `perch ls` output.
export function linkTarget<W extends { machineId: string; id: string; status: string }>(
  workspaces: readonly W[],
  id: string,
  preferMachineId: string | null,
): W | null {
  const matches = workspaces.filter((w) => w.id === id && w.status !== 'parked');
  return matches.find((w) => w.machineId === preferMachineId) ?? matches[0] ?? null;
}
