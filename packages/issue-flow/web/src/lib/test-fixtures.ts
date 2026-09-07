import type { WorktreeInfo } from './types';

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
    tabs: [],
    activeTabId: null,
    supportsTabs: false,
    executionId: null,
    issueRef: null,
    ...overrides,
  };
}
