import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorktree } from './test-fixtures';
import type { LinearIssue, WorktreeInfo, WorktreeListRow } from './types';
import WorktreeList from './WorktreeList.svelte';

/**
 * PORT of `frontend/src/lib/WorktreeList.test.ts` @ d8c9d5f, in pt-BR.
 */

function liveWorktree(branch: string, overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return createWorktree(branch, {
    agent: 'working',
    mux: '✓',
    status: 'running',
    elapsed: '1m',
    ...overrides,
  });
}

const linearIssue: LinearIssue = {
  id: 'id-42',
  identifier: 'ENG-42',
  title: 'Conectar lista',
  description: null,
  priority: 2,
  priorityLabel: 'Alta',
  url: 'https://linear/ENG-42',
  branchName: 'eng-42-conectar-lista',
  dueDate: null,
  updatedAt: '2026-09-06T00:00:00Z',
  state: { name: 'A fazer', color: '#ffaa00', type: 'unstarted' },
  team: { name: 'Engenharia', key: 'ENG' },
  labels: [],
  project: null,
};

function createRow(worktree: WorktreeInfo, depth = 0): WorktreeListRow {
  return { worktree, depth };
}

function renderList(
  rows: WorktreeListRow[],
  overrides: Partial<Record<string, unknown>> = {},
): ReturnType<typeof render> {
  return render(WorktreeList, {
    props: {
      rows,
      selected: null,
      removing: new Set<string>(),
      initializing: new Set<string>(),
      archiving: new Set<string>(),
      notifiedBranches: new Set<string>(),
      onselect: vi.fn(),
      onclose: vi.fn(),
      onarchive: vi.fn(),
      onmerge: vi.fn(),
      oncreatesubworktree: vi.fn(),
      onremove: vi.fn(),
      oneditprofile: vi.fn(),
      ...overrides,
    },
  });
}

describe('WorktreeList', () => {
  afterEach(() => cleanup());

  it('calls onremove without selecting the row when the remove button is clicked', async () => {
    const onselect = vi.fn();
    const onremove = vi.fn();

    const { container } = renderList([createRow(liveWorktree('feature/list-actions'))], {
      onselect,
      onremove,
    });

    await fireEvent.click(
      within(container).getByRole('button', { name: /ações de feature\/list-actions/i }),
    );
    await fireEvent.click(within(container).getByRole('button', { name: 'Remover' }));

    expect(onremove).toHaveBeenCalledWith('feature/list-actions');
    expect(onselect).not.toHaveBeenCalled();
  });

  it('disables row actions while a worktree is being removed', () => {
    const { container } = renderList([createRow(liveWorktree('feature/list-removing'))], {
      removing: new Set(['feature/list-removing']),
    });

    expect(screen.getByText('feature/list-removing').closest('button')).toBeDisabled();
    expect(
      within(container).getByRole('button', { name: /ações de feature\/list-removing/i }),
    ).toBeDisabled();
  });

  it('shows a three-dot menu with row actions', async () => {
    const onarchive = vi.fn();

    renderList([createRow(liveWorktree('feature/menu-actions'))], { onarchive });

    await fireEvent.click(screen.getByRole('button', { name: /ações de feature\/menu-actions/i }));

    expect(screen.getByRole('button', { name: 'Fechar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Arquivar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Integrar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remover' })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Arquivar' }));
    expect(onarchive).toHaveBeenCalledWith('feature/menu-actions');
  });

  it('calls oncreatesubworktree with the row branch from the menu', async () => {
    const oncreatesubworktree = vi.fn();

    renderList([createRow(liveWorktree('feature/sub-base'))], { oncreatesubworktree });

    await fireEvent.click(screen.getByRole('button', { name: /ações de feature\/sub-base/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Criar worktree derivado' }));

    expect(oncreatesubworktree).toHaveBeenCalledWith('feature/sub-base');
  });

  it('renders labels as the primary row name with the branch below', () => {
    renderList([createRow(liveWorktree('feature/random-fallback', { label: 'Ranking da busca' }))]);

    expect(screen.getByText('Ranking da busca')).toBeInTheDocument();
    expect(screen.getByText('feature/random-fallback')).toBeInTheDocument();
  });

  it('places archived and closed row badges below the worktree name', () => {
    renderList([
      createRow(
        liveWorktree('feature/very-long-archived-closed-name', {
          archived: true,
          mux: '',
        }),
      ),
    ]);

    const name = screen.getByText('feature/very-long-archived-closed-name');
    const archived = screen.getByText('arquivado');
    const closed = screen.getByText('fechado');
    const nameRow = name.closest('[data-worktree-name-row]');
    const badgeRow = archived.closest('[data-worktree-badge-row]');

    if (!nameRow || !badgeRow) {
      throw new Error('Expected separate name and badge rows');
    }

    expect(nameRow).not.toContainElement(archived);
    expect(badgeRow).toContainElement(archived);
    expect(badgeRow).toContainElement(closed);
  });

  it('disables the archive action while the row is archiving', async () => {
    renderList([createRow(liveWorktree('feature/archiving'))], {
      archiving: new Set(['feature/archiving']),
    });

    await fireEvent.click(screen.getByRole('button', { name: /ações de feature\/archiving/i }));

    expect(screen.getByRole('button', { name: 'Arquivar' })).toBeDisabled();
  });

  it('shows the linked issue on the badge row', () => {
    renderList([createRow(liveWorktree('feature/issue-linked', { issueRef: '142' }))]);

    const badge = screen.getByText('142');
    expect(badge.closest('[data-worktree-badge-row]')).not.toBeNull();
  });

  it('shows a Linear badge and posts through the row menu', async () => {
    const onposttolinear = vi.fn();
    renderList([createRow(liveWorktree('feature/linear', { linearIssue }))], {
      canPostToLinear: true,
      onposttolinear,
    });

    expect(screen.getByText('ENG-42')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /ações de feature\/linear/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Enviar conversa para ENG-42' }));
    expect(onposttolinear).toHaveBeenCalledWith('feature/linear');
  });
});
