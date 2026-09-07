import { describe, expect, it, vi } from 'vitest';
import type { ResolvedAgentSessionContext } from '../../agents/session/context.js';
import { filterLinearAutoCreateIssues, runLinearAutoCreateOnce } from './auto-create.js';
import type { LinearClient, LinearIssue } from './client.js';

function issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'id-1',
    identifier: 'ENG-1',
    title: 'Ticket',
    description: null,
    priority: 0,
    priorityLabel: 'No priority',
    url: 'https://linear/ENG-1',
    branchName: 'eng-1-ticket',
    dueDate: null,
    updatedAt: '2026-09-06T00:00:00Z',
    state: { name: 'Todo', color: '#aaa', type: 'unstarted' },
    team: { name: 'Engineering', key: 'ENG' },
    labels: [{ name: 'issue-flow', color: '#fff' }],
    project: null,
    ...overrides,
  };
}

describe('Linear auto-create selection', () => {
  it('selects only labeled, unstarted, watched and unprocessed issues', () => {
    const chosen = issue();
    const result = filterLinearAutoCreateIssues(
      [
        chosen,
        issue({ id: 'started', state: { name: 'Started', color: '#aaa', type: 'started' } }),
        issue({ id: 'wrong-label', labels: [] }),
        issue({ id: 'wrong-team', team: { name: 'Web', key: 'WEB' } }),
        issue({ id: 'processed' }),
      ],
      new Set(),
      new Set(['processed']),
      ['ENG'],
    );
    expect(result).toEqual([chosen]);
  });

  it('recognizes an existing issue branch even with a local prefix', () => {
    expect(
      filterLinearAutoCreateIssues([issue()], new Set(['agent/feature/eng-1-ticket']), new Set()),
    ).toEqual([]);
  });

  it('honors branches in the raw Git registry even when Issue Flow does not manage them', async () => {
    const openWorktrees = vi.fn();
    await expect(
      runLinearAutoCreateOnce({
        context: {
          projectRoot: '/repo',
          git: {
            listWorktrees: async () => [
              {
                path: '/external',
                branch: 'eng-1-ticket',
                head: 'abc',
                detached: false,
                bare: false,
              },
            ],
          },
        } as unknown as ResolvedAgentSessionContext,
        client: { fetchAssignedIssues: async () => [issue()] } as unknown as LinearClient,
        agentId: 'codex',
        openWorktrees,
      }),
    ).resolves.toEqual([]);
    expect(openWorktrees).not.toHaveBeenCalled();
  });

  it('does not create after teardown aborts an in-flight Linear fetch', async () => {
    let finishFetch: ((issues: LinearIssue[]) => void) | undefined;
    const client = {
      fetchAssignedIssues: vi.fn(
        () =>
          new Promise<LinearIssue[]>((resolve) => {
            finishFetch = resolve;
          }),
      ),
    } as unknown as LinearClient;
    const openWorktrees = vi.fn();
    const controller = new AbortController();
    const running = runLinearAutoCreateOnce({
      context: {} as ResolvedAgentSessionContext,
      client,
      agentId: 'codex',
      signal: controller.signal,
      openWorktrees,
    });
    await Promise.resolve();

    controller.abort();
    finishFetch?.([issue()]);

    await expect(running).resolves.toEqual([]);
    expect(openWorktrees).not.toHaveBeenCalled();
  });

  it('opens eligible tickets with the project default agent', async () => {
    const openWorktrees = vi.fn(async () => ({
      primaryBranch: 'eng-1-ticket',
      branches: ['eng-1-ticket'],
    }));
    const result = await runLinearAutoCreateOnce({
      context: {
        projectRoot: '/repo',
        git: { listWorktrees: async () => [] },
      } as unknown as ResolvedAgentSessionContext,
      client: { fetchAssignedIssues: async () => [issue()] } as unknown as LinearClient,
      agentId: 'codex',
      openWorktrees: openWorktrees as never,
    });

    expect(result).toEqual(['eng-1-ticket']);
    expect(openWorktrees).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agents: ['codex'],
      }),
    );
  });
});
