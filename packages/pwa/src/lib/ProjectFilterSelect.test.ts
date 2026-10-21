import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import ProjectFilterSelect from './ProjectFilterSelect.svelte';
import type { ProjectFolder } from '../core/project-folders';

const folders: ProjectFolder[] = [
  { key: 'perch', label: 'perch', count: 3, depth: 0 },
  { key: 'other', label: 'other', count: 1, depth: 0 },
];

const props = (over: Record<string, unknown> = {}) => ({
  folders,
  selected: new Set<string>(),
  mode: 'only' as const,
  ontoggle: vi.fn(),
  onmode: vi.fn(),
  onclear: vi.fn(),
  ...over,
});

describe('ProjectFilterSelect', () => {
  it('shows a nested folder by its short label, indented under its parent', async () => {
    const tree: ProjectFolder[] = [
      { key: 'bar', label: 'bar', count: 2, depth: 0 },
      { key: 'bar/baz', label: 'baz', count: 2, depth: 1 },
    ];
    const ontoggle = vi.fn();
    render(ProjectFilterSelect, { props: props({ folders: tree, ontoggle }) });
    await fireEvent.click(screen.getByLabelText(/filter by project/i));
    const child = screen.getByRole('checkbox', { name: /baz/i });
    const parent = screen.getByRole('checkbox', { name: /^bar/i });
    expect(child.closest('label')!.getAttribute('style')).toContain('--depth: 1');
    expect(parent.closest('label')!.getAttribute('style')).toContain('--depth: 0');
    await fireEvent.click(child);
    expect(ontoggle).toHaveBeenCalledWith('bar/baz');
  });

  it('summarizes a single nested selection by its full path', () => {
    const tree: ProjectFolder[] = [
      { key: 'bar', label: 'bar', count: 2, depth: 0 },
      { key: 'bar/baz', label: 'baz', count: 2, depth: 1 },
    ];
    render(ProjectFilterSelect, { props: props({ folders: tree, selected: new Set(['bar/baz']) }) });
    expect(screen.getByLabelText(/filter by project/i)).toHaveTextContent('bar/baz');
  });

  it('opens the menu when the summary is clicked', async () => {
    render(ProjectFilterSelect, { props: props() });
    expect(screen.queryByRole('button', { name: /close project filter/i })).toBeNull();
    await fireEvent.click(screen.getByLabelText(/filter by project/i));
    expect(screen.getByRole('group', { name: /projects/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /close project filter/i })).toBeTruthy();
  });

  it('closes on an outside tap via the backdrop', async () => {
    render(ProjectFilterSelect, { props: props() });
    await fireEvent.click(screen.getByLabelText(/filter by project/i));
    await fireEvent.click(screen.getByRole('button', { name: /close project filter/i }));
    expect(screen.queryByRole('button', { name: /close project filter/i })).toBeNull();
  });

  it('closes on Escape', async () => {
    render(ProjectFilterSelect, { props: props() });
    await fireEvent.click(screen.getByLabelText(/filter by project/i));
    expect(screen.getByRole('button', { name: /close project filter/i })).toBeTruthy();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /close project filter/i })).toBeNull();
  });

  it('summarises the selection with the verb of the active mode', () => {
    const { unmount } = render(ProjectFilterSelect, {
      props: props({ selected: new Set(['perch']), mode: 'only' }),
    });
    expect(screen.getByLabelText(/filter by project/i).textContent).toContain('Only perch');
    unmount();
    render(ProjectFilterSelect, { props: props({ selected: new Set(['perch']), mode: 'hide' }) });
    expect(screen.getByLabelText(/filter by project/i).textContent).toContain('Hiding perch');
  });

  it('summarises an empty selection as all projects in either mode', () => {
    render(ProjectFilterSelect, { props: props({ mode: 'hide' }) });
    expect(screen.getByLabelText(/filter by project/i).textContent).toContain('All projects');
  });

  it('summarises several hidden projects as a count', () => {
    render(ProjectFilterSelect, {
      props: props({ selected: new Set(['perch', 'other']), mode: 'hide' }),
    });
    expect(screen.getByLabelText(/filter by project/i).textContent).toContain('Hiding 2 projects');
  });

  it('reports a mode change from the segmented control', async () => {
    const onmode = vi.fn();
    render(ProjectFilterSelect, { props: props({ onmode }) });
    await fireEvent.click(screen.getByLabelText(/filter by project/i));
    await fireEvent.click(screen.getByRole('radio', { name: /^hide$/i }));
    expect(onmode).toHaveBeenCalledWith('hide');
  });

  it('marks the active mode as the checked radio', async () => {
    render(ProjectFilterSelect, { props: props({ mode: 'hide' }) });
    await fireEvent.click(screen.getByLabelText(/filter by project/i));
    expect(screen.getByRole('radio', { name: /^hide$/i }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /show only/i }).getAttribute('aria-checked')).toBe('false');
  });

  it('does not close when a checkbox inside the menu is clicked', async () => {
    const ontoggle = vi.fn();
    render(ProjectFilterSelect, { props: props({ ontoggle }) });
    await fireEvent.click(screen.getByLabelText(/filter by project/i));
    await fireEvent.click(screen.getByRole('checkbox', { name: /perch/i }));
    expect(ontoggle).toHaveBeenCalledWith('perch');
    expect(screen.getByRole('button', { name: /close project filter/i })).toBeTruthy();
  });

  it('offers no clear button while nothing is selected', () => {
    render(ProjectFilterSelect, { props: props() });
    expect(screen.queryByRole('button', { name: /clear project filter/i })).toBeNull();
  });

  it('clears the selection from the closed control without opening the menu', async () => {
    const onclear = vi.fn();
    render(ProjectFilterSelect, { props: props({ selected: new Set(['perch']), onclear }) });
    await fireEvent.click(screen.getByRole('button', { name: /clear project filter/i }));
    expect(onclear).toHaveBeenCalledOnce();
    expect(screen.queryByRole('group', { name: /projects/i })).toBeNull();
  });

  it('stays visible with a single folder while a selection is active', () => {
    render(ProjectFilterSelect, {
      props: props({ folders: [folders[0]], selected: new Set(['perch']) }),
    });
    expect(screen.getByRole('button', { name: /clear project filter/i })).toBeTruthy();
  });

  it('hides itself with a single folder and no selection', () => {
    render(ProjectFilterSelect, { props: props({ folders: [folders[0]] }) });
    expect(screen.queryByLabelText(/filter by project/i)).toBeNull();
  });
});
