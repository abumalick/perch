import { describe, expect, it } from 'vitest';
import { findWorkspaceIds, linkTarget } from './workspace-id-links';

const cells = (text: string) => [...text].map((chars) => ({ chars, width: 1 }));

describe('findWorkspaceIds', () => {
  it('finds a perch id and its cell columns', () => {
    expect(findWorkspaceIds(cells('spawned perch-39a7f6 ok'))).toEqual([
      { id: 'perch-39a7f6', startCol: 8, endCol: 19 },
    ]);
  });

  it('finds several ids on one line', () => {
    expect(findWorkspaceIds(cells('perch-000000  perch-abcdef')).map((m) => m.id)).toEqual([
      'perch-000000',
      'perch-abcdef',
    ]);
  });

  it('ignores ids that are not exactly six hex characters', () => {
    expect(findWorkspaceIds(cells('perch-demo perch-12345 perch-1234567 perch-ABCDEF xperch-123456'))).toEqual([]);
  });

  // A wide character (CJK, emoji) takes two cells: the second has width 0 and no chars.
  it('maps columns past wide characters', () => {
    const line = [
      { chars: '漢', width: 2 },
      { chars: '', width: 0 },
      ...cells(' perch-123abc'),
    ];
    expect(findWorkspaceIds(line)).toEqual([{ id: 'perch-123abc', startCol: 3, endCol: 14 }]);
  });

  // An emoji is two UTF-16 code units in one cell.
  it('maps columns past multi-unit cells', () => {
    const line = [{ chars: '😀', width: 2 }, { chars: '', width: 0 }, ...cells('perch-123abc')];
    expect(findWorkspaceIds(line)).toEqual([{ id: 'perch-123abc', startCol: 2, endCol: 13 }]);
  });

  it('treats an empty cell as a space', () => {
    const line = [...cells('a'), { chars: '', width: 1 }, ...cells('perch-123abc')];
    expect(findWorkspaceIds(line)).toEqual([{ id: 'perch-123abc', startCol: 2, endCol: 13 }]);
  });
});

describe('linkTarget', () => {
  const ws = (machineId: string, id: string, status = 'idle') => ({ machineId, id, status });

  it('returns the listed workspace with that id', () => {
    expect(linkTarget([ws('mac', 'perch-aaaaaa')], 'perch-aaaaaa', null)).toEqual(ws('mac', 'perch-aaaaaa'));
  });

  it('returns null for an unknown id', () => {
    expect(linkTarget([ws('mac', 'perch-aaaaaa')], 'perch-bbbbbb', 'mac')).toBeNull();
  });

  it('prefers the given machine when the id is listed on several', () => {
    const list = [ws('mac', 'perch-aaaaaa'), ws('linux', 'perch-aaaaaa')];
    expect(linkTarget(list, 'perch-aaaaaa', 'linux')).toEqual(ws('linux', 'perch-aaaaaa'));
  });

  it('leaves a parked workspace out', () => {
    expect(linkTarget([ws('mac', 'perch-aaaaaa', 'parked')], 'perch-aaaaaa', 'mac')).toBeNull();
  });

  it('skips a parked copy for a live one on another machine', () => {
    const list = [ws('mac', 'perch-aaaaaa', 'parked'), ws('linux', 'perch-aaaaaa')];
    expect(linkTarget(list, 'perch-aaaaaa', 'mac')).toEqual(ws('linux', 'perch-aaaaaa'));
  });

  it('falls back to another machine', () => {
    expect(linkTarget([ws('linux', 'perch-aaaaaa')], 'perch-aaaaaa', 'mac')).toEqual(ws('linux', 'perch-aaaaaa'));
  });
});
