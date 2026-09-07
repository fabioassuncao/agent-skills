import type { WorktreeInfo } from './types';

/**
 * Fixtures shared by the ported suites.
 *
 * The upstream repeats `createWorktree` in four test files. Keeping one copy
 * matters here for a specific reason: `WorktreeInfo` gained `executionId` and
 * `issueRef` (§48.3), and four independent copies is four places to forget a
 * new field — which fails as a type error in one suite and as a silently wrong
 * fixture in the others.
 */
export function createWorktree(
  branch: string,
  overrides: Partial<WorktreeInfo> = {},
): WorktreeInfo {
  return {
    branch,
    label: null,
    archived: false,
    agent: 'waiting',
    mux: '',
    path: `/repo/__worktrees/${branch}`,
    dir: `/repo/__worktrees/${branch}`,
    dirty: false,
    unpushed: false,
    status: 'idle',
    elapsed: '',
    profile: null,
    agentName: null,
    agentLabel: null,
    agentTerminalStale: false,
    services: [],
    paneCount: 1,
    prs: [],
    creating: false,
    creationPhase: null,
    source: 'ui',
    oneshot: null,
    tabs: [],
    activeTabId: null,
    supportsTabs: false,
    executionId: null,
    issueRef: null,
    ...overrides,
  };
}
