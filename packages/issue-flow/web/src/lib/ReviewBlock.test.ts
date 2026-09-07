import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionSnapshot } from './execution-fixtures';
import ReviewBlock, { reviewExecutions } from './ReviewBlock.svelte';
import type { PrEntry } from './types';

/**
 * "Review" — I6.
 *
 * The criterion is one screen holding both halves: what the independent
 * reviewer concluded and what people wrote on the pull request. Two panels
 * would have been the two interfaces again (§50.2 marks the row `M`), so every
 * case below asserts against the **same** section.
 */

afterEach(cleanup);

function pr(overrides: Partial<PrEntry> = {}): PrEntry {
  return {
    repo: '',
    number: 7,
    state: 'open',
    isDraft: false,
    url: 'https://example.test/pr/7',
    updatedAt: '2026-09-06T09:00:00.000Z',
    ciStatus: 'success',
    ciChecks: [],
    comments: [],
    ...overrides,
  };
}

describe('which executions count as a review', () => {
  it('keeps review, pr-review and verify, and nothing else', () => {
    const snapshot = createExecutionSnapshot({
      executions: [
        { id: 'e1', purpose: 'execute' },
        { id: 'e2', purpose: 'review' },
        { id: 'e3', purpose: 'pr-review' },
        { id: 'e4', purpose: 'verify' },
        { id: 'e5', purpose: 'plan' },
      ],
    });
    expect(reviewExecutions(snapshot).map((execution) => execution.id)).toEqual(['e2', 'e3', 'e4']);
    expect(reviewExecutions(null)).toEqual([]);
  });
});

describe('the review panel (I6)', () => {
  it('puts the reviewer findings and the PR comments in one section', () => {
    const snapshot = createExecutionSnapshot({
      executions: [
        {
          id: 'e2',
          purpose: 'review',
          attempt: 2,
          status: 'completed',
          // The snapshot nests both: `verdict.status` and `failure.message`.
          verdict: { status: 'changes_requested' },
          failure: { message: 'US-2 sem teste de regressão' },
          finishedAt: '2026-09-06T10:00:00.000Z',
        },
      ],
    });

    render(ReviewBlock, {
      props: {
        snapshot,
        hasPullRequestSync: true,
        pullRequests: [
          pr({
            comments: [
              {
                type: 'inline',
                author: 'alice',
                body: 'isto precisa de teste',
                createdAt: '2026-09-06T10:01:00.000Z',
                path: 'src/a.ts',
              },
            ],
          }),
        ],
      },
    });

    const section = screen.getByText('Review').closest('section') as HTMLElement;
    // The reviewer's half…
    expect(within(section).getByText(/review · tentativa 2/)).toBeInTheDocument();
    expect(within(section).getByText('veredito: changes_requested')).toBeInTheDocument();
    expect(within(section).getByText('US-2 sem teste de regressão')).toBeInTheDocument();
    // …and the pull request's, in the same section.
    expect(within(section).getByText('1 comentário')).toBeInTheDocument();
    expect(within(section).getByText('alice · src/a.ts')).toBeInTheDocument();
  });

  it('never invents a verdict the reviewer did not reach', () => {
    render(ReviewBlock, {
      props: {
        snapshot: createExecutionSnapshot({
          executions: [{ id: 'e2', purpose: 'review', status: 'running' }],
        }),
      },
    });
    expect(screen.getByText('veredito: —')).toBeInTheDocument();
  });

  it('says the monitor does not consult GitHub rather than "no comments"', () => {
    render(ReviewBlock, {
      props: { snapshot: createExecutionSnapshot(), hasPullRequestSync: false },
    });
    expect(
      screen.getByText(/não consulta o GitHub, então não há comentários/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Nenhum comentário nos pull requests/)).not.toBeInTheDocument();
  });

  it('distinguishes "no comments" from "not consulted" once the sync is on', () => {
    render(ReviewBlock, {
      props: {
        snapshot: createExecutionSnapshot(),
        hasPullRequestSync: true,
        pullRequests: [pr()],
      },
    });
    expect(
      screen.getByText('Nenhum comentário nos pull requests desta branch.'),
    ).toBeInTheDocument();
  });

  it('opens the comment dialog for the pull request it names', async () => {
    const onopencomments = vi.fn();
    const entry = pr({
      comments: [
        {
          type: 'comment',
          author: 'bob',
          body: 'ok',
          createdAt: '2026-09-06T10:02:00.000Z',
        },
      ],
    });
    render(ReviewBlock, {
      props: {
        snapshot: createExecutionSnapshot(),
        hasPullRequestSync: true,
        pullRequests: [entry],
        onopencomments,
      },
    });

    await fireEvent.click(screen.getByText('Ver e responder'));
    expect(onopencomments).toHaveBeenCalledWith(entry);
  });

  it('says nothing happened rather than showing an empty list when no review ran', () => {
    render(ReviewBlock, { props: { snapshot: createExecutionSnapshot({ executions: [] }) } });
    expect(screen.getByText('Nenhuma revisão registrada nesta execução.')).toBeInTheDocument();
  });
});
