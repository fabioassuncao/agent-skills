import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TopBar from './TopBar.svelte';
import { createWorktree } from './test-fixtures';
import type { WorktreeInfo } from './types';

/**
 * PORT of `frontend/src/lib/TopBar.test.ts` @ d8c9d5f.
 */

function renderTopBar(
  branch: string,
  overrides: Partial<WorktreeInfo> = {},
): ReturnType<typeof render> {
  return render(TopBar, {
    props: {
      name: branch,
      worktree: createWorktree(branch, { mux: '✓', status: 'running', ...overrides }),
      sshHost: '',
      linkedRepos: [],
      notificationHistory: [],
      unreadCount: 0,
      onclose: vi.fn(),
      onarchive: vi.fn(),
      onmerge: vi.fn(),
      onremove: vi.fn(),
      onsettings: vi.fn(),
      onCiClick: vi.fn(),
      onReviewsClick: vi.fn(),
    },
  });
}

describe('TopBar', () => {
  afterEach(() => cleanup());

  it('truncates worktree names longer than 30 characters in the header', () => {
    const branch = 'feature/abcdefghijklmnopqrstuvwxyz-1234567890';

    renderTopBar(branch);

    const truncated = `${branch.slice(0, 27)}...`;
    const header = screen.getByText(truncated);

    expect(truncated).toHaveLength(30);
    expect(header).toHaveAttribute('title', branch);
  });

  it('shows short worktree names without truncation', () => {
    const branch = 'feature/short-name';

    renderTopBar(branch);

    const header = screen.getByText(branch);

    expect(header).toHaveAttribute('title', branch);
  });

  it('shows workspace labels above the real branch name', () => {
    const branch = 'feature/random-fallback';

    render(TopBar, {
      props: {
        name: branch,
        worktree: createWorktree(branch, { mux: '✓', label: 'Ranking da busca' }),
        sshHost: '',
        linkedRepos: [],
        notificationHistory: [],
        unreadCount: 0,
        onclose: vi.fn(),
        onarchive: vi.fn(),
        onmerge: vi.fn(),
        onremove: vi.fn(),
        oneditlabel: vi.fn(),
        onsettings: vi.fn(),
        onCiClick: vi.fn(),
        onReviewsClick: vi.fn(),
      },
    });

    expect(screen.getByText('Ranking da busca')).toBeInTheDocument();
    expect(screen.getByText(branch)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Editar o rótulo do workspace' }),
    ).toBeInTheDocument();
  });

  it('keeps the product name out of the header', () => {
    // The most visible line on the screen is for what is happening, not for the
    // brand — the current panel's rule, carried over.
    const branch = 'feature/brand';
    const { container } = renderTopBar(branch);

    expect(container.textContent).not.toContain('issue-flow');
  });

  it('does not render stale terminal state in the top bar', () => {
    // The stale banner belongs to the terminal, which owns the state; showing
    // it twice makes the refresh button ambiguous.
    const branch = 'feature/stale-terminal';

    renderTopBar(branch, { agentTerminalStale: true });

    expect(screen.queryByText('Terminal desatualizado')).not.toBeInTheDocument();
  });

  it('keeps desktop PR badges inside a wrapping header container', () => {
    const branch = 'feature/header-wrap';
    const { container } = renderTopBar(branch, {
      prs: [
        {
          repo: 'origin',
          number: 42,
          state: 'open',
          isDraft: false,
          url: 'https://github.com/example/repo/pull/42',
          updatedAt: '2026-03-23T12:00:00.000Z',
          ciStatus: 'success',
          ciChecks: [],
          comments: [],
        },
      ],
    });

    const badgeContainer = container.querySelector('.topbar-main-prs');
    const repoGroup = badgeContainer?.querySelector('.repo-group');

    expect(badgeContainer).not.toBeNull();
    expect(badgeContainer?.className).toContain('flex-1');
    expect(repoGroup).not.toBeNull();
    expect(repoGroup?.className).toContain('flex-wrap');
  });

  it('shows a linked Linear issue and opens its detail action', () => {
    const onlinearclick = vi.fn();
    const linked = {
      id: 'id-7',
      identifier: 'ENG-7',
      title: 'Badge',
      description: null,
      priority: 0,
      priorityLabel: 'Sem prioridade',
      url: 'https://linear/ENG-7',
      branchName: 'eng-7-badge',
      dueDate: null,
      updatedAt: '2026-09-06T00:00:00Z',
      state: { name: 'A fazer', color: '#ffaa00', type: 'unstarted' },
      team: { name: 'Engenharia', key: 'ENG' },
      labels: [],
      project: null,
    };
    render(TopBar, {
      props: {
        name: 'eng-7-badge',
        worktree: createWorktree('eng-7-badge', { linearIssue: linked }),
        sshHost: '',
        onclose: vi.fn(),
        onarchive: vi.fn(),
        onmerge: vi.fn(),
        onremove: vi.fn(),
        onsettings: vi.fn(),
        onCiClick: vi.fn(),
        onReviewsClick: vi.fn(),
        onlinearclick,
      },
    });
    screen.getByRole('button', { name: 'Ver ENG-7 no Linear' }).click();
    expect(onlinearclick).toHaveBeenCalledWith(linked);
  });
});
