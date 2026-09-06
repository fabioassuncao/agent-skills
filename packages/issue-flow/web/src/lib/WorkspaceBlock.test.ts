import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorktree } from './test-fixtures';
import WorkspaceBlock from './WorkspaceBlock.svelte';

/**
 * "Sessões e worktrees" — I1, and half of I2.
 *
 * The block is the same for a Task and for a free session, so the cases below
 * exercise both shapes through the **same** component: N rows with a heading
 * that says "sessions", and one row with a heading that says "workspace".
 * A second component for the second shape is the anti-pattern phase 8D exists
 * to avoid, and these cases are what would notice it reappearing.
 */

afterEach(cleanup);

describe('the workspace block (I1)', () => {
  it('lists the sessions and worktrees it is given, with branch, agent and profile', () => {
    render(WorkspaceBlock, {
      props: {
        title: 'Sessões e worktrees',
        worktrees: [
          createWorktree('feat/42-a', {
            label: 'Primeira',
            agentName: 'claude',
            agentLabel: 'Claude',
            profile: 'default',
            executionId: 'run-42',
            dirty: true,
          }),
          createWorktree('feat/42-b', { agentName: 'codex', executionId: 'run-42' }),
        ],
      },
    });

    expect(screen.getByText('Sessões e worktrees')).toBeInTheDocument();
    expect(screen.getByText('Primeira')).toBeInTheDocument();
    // The labelled row keeps its branch beside the label; the unlabelled row is
    // named by its branch, and repeating it would be noise on every row.
    expect(screen.getByText('feat/42-a')).toBeInTheDocument();
    expect(screen.getByText('feat/42-b')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('profile default')).toBeInTheDocument();
    expect(screen.getByText('alterações não commitadas')).toBeInTheDocument();
  });

  it('says so plainly when a Task has no session open, instead of an empty box', () => {
    render(WorkspaceBlock, {
      props: {
        title: 'Sessões e worktrees',
        worktrees: [],
        emptyMessage: 'Nenhuma sessão aberta para esta execução.',
      },
    });
    expect(screen.getByText('Nenhuma sessão aberta para esta execução.')).toBeInTheDocument();
  });

  it('shows a probed service as up and an unallocated port as not', () => {
    render(WorkspaceBlock, {
      props: {
        title: 'Worktree e serviços',
        worktrees: [
          createWorktree('session/a', {
            services: [
              { name: 'web', port: 4321, running: true, url: 'http://127.0.0.1:4321' },
              { name: 'api', port: null, running: false },
            ],
          }),
        ],
      },
    });

    const up = screen.getByText('web:4321');
    expect(up).toHaveAttribute('href', 'http://127.0.0.1:4321');
    expect(up.closest('.wt-service')).toHaveClass('is-up');
    expect(screen.getByText('api').closest('.wt-service')).not.toHaveClass('is-up');
  });

  /**
   * I2: from a story to the terminal of the agent running it.
   *
   * The story's drawer names the execution, the execution's rows are here, and
   * this button is the last hop — it selects the workspace **and** moves to the
   * terminal tab, which is what "arriving at the terminal" means.
   */
  it('offers the terminal only for a session that has a pane to attach to (I2)', async () => {
    const onopenterminal = vi.fn();
    render(WorkspaceBlock, {
      props: {
        title: 'Sessões e worktrees',
        worktrees: [
          createWorktree('feat/42-a', { mux: '✓' }),
          createWorktree('feat/42-b', { mux: '' }),
        ],
        onopenterminal,
      },
    });

    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0] as HTMLElement).getByText('Terminal')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByText('Terminal')).not.toBeInTheDocument();

    await fireEvent.click(within(rows[0] as HTMLElement).getByText('Terminal'));
    expect(onopenterminal).toHaveBeenCalledWith('feat/42-a');
  });

  it('marks the workspace on screen, so a Task with several says which one it means', () => {
    render(WorkspaceBlock, {
      props: {
        title: 'Sessões e worktrees',
        worktrees: [createWorktree('feat/42-a'), createWorktree('feat/42-b')],
        selected: 'feat/42-b',
      },
    });

    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).not.toHaveClass('is-selected');
    expect(rows[1]).toHaveClass('is-selected');
  });

  it('reports the row a person picks without leaving the Task', async () => {
    const onselect = vi.fn();
    render(WorkspaceBlock, {
      props: {
        title: 'Sessões e worktrees',
        worktrees: [createWorktree('feat/42-a')],
        onselect,
      },
    });

    await fireEvent.click(screen.getByRole('listitem').querySelector('.wt-link') as HTMLElement);
    expect(onselect).toHaveBeenCalledWith('feat/42-a');
  });
});
