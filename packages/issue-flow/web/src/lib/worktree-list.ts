import type { WorktreeInfo, WorktreeListRow } from './types';
import { searchMatch } from './utils';

/**
 * PORT of `frontend/src/lib/worktree-list.ts` @ d8c9d5f (130 lines).
 *
 * The sidebar's ordering and its overflow bars, kept as pure functions so they
 * are testable without a DOM — which is why the upstream's twelve cases port
 * unchanged.
 *
 * §48.1 calls this ordering `compareWorktreeOrder`; the function does not exist
 * upstream under that name. What actually orders the list is
 * `buildWorktreeListRows`, a parent-first walk that indents a worktree under
 * the worktree it was branched from. Recorded as a specification divergence,
 * not silently renamed.
 *
 * Both provider-neutral `issueRef` and the optional Linear identifier enter
 * the search haystack, so a linked workspace remains findable by either id.
 */

export interface FilterWorktreesOptions {
  query: string;
  showArchived: boolean;
}

function parentBranchOf(
  worktree: WorktreeInfo,
  worktreesByBranch: Map<string, WorktreeInfo>,
): string | null {
  if (!worktree.baseBranch || worktree.baseBranch === worktree.branch) {
    return null;
  }

  return worktreesByBranch.has(worktree.baseBranch) ? worktree.baseBranch : null;
}

export function matchesWorktreeSearch(worktree: WorktreeInfo, query: string): boolean {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return true;

  return [
    worktree.label ?? '',
    worktree.branch,
    worktree.baseBranch ?? '',
    worktree.profile ?? '',
    worktree.agentLabel ?? '',
    worktree.agentName ?? '',
    worktree.issueRef ?? '',
    worktree.linearIssue?.identifier ?? '',
    worktree.linearIssue?.title ?? '',
  ].some((value) => searchMatch(trimmedQuery, value));
}

export function filterWorktrees(
  worktrees: WorktreeInfo[],
  options: FilterWorktreesOptions,
): WorktreeInfo[] {
  return worktrees.filter(
    (worktree) =>
      (options.showArchived || !worktree.archived) &&
      matchesWorktreeSearch(worktree, options.query),
  );
}

export function countArchivedMatches(worktrees: WorktreeInfo[], query: string): number {
  return worktrees.filter((worktree) => worktree.archived && matchesWorktreeSearch(worktree, query))
    .length;
}

export const OVERFLOW_STATUS_BAR_STATUSES = ['waiting', 'error', 'done-unread'] as const;
export type OverflowStatusBarStatus = (typeof OVERFLOW_STATUS_BAR_STATUSES)[number];

export function rowShowsAgentStatus(worktree: WorktreeInfo): boolean {
  return worktree.mux === '✓' && !worktree.creating;
}

/**
 * The countable mark a row contributes to the overflow bars, mirroring the
 * per-row indicator: waiting, error, or a finished run that has not been looked
 * at yet.
 */
export function overflowStatusOf(
  worktree: WorktreeInfo,
  notifiedBranches: Set<string>,
): OverflowStatusBarStatus | null {
  if (!rowShowsAgentStatus(worktree)) return null;
  if (worktree.agent === 'waiting') return 'waiting';
  if (worktree.agent === 'error') return 'error';
  if (worktree.agent === 'done' && notifiedBranches.has(worktree.branch)) return 'done-unread';
  return null;
}

export function countAgentStatusesIn(
  rows: WorktreeListRow[],
  branches: Set<string>,
  notifiedBranches: Set<string> = new Set(),
): Record<OverflowStatusBarStatus, number> {
  const counts: Record<OverflowStatusBarStatus, number> = {
    waiting: 0,
    error: 0,
    'done-unread': 0,
  };
  for (const { worktree } of rows) {
    if (!branches.has(worktree.branch)) continue;
    const status = overflowStatusOf(worktree, notifiedBranches);
    if (status) counts[status]++;
  }
  return counts;
}

export function branchesWithAgentStatus(
  rows: WorktreeListRow[],
  status: OverflowStatusBarStatus,
  branches?: Set<string>,
  notifiedBranches: Set<string> = new Set(),
): string[] {
  return rows
    .filter(
      ({ worktree }) =>
        overflowStatusOf(worktree, notifiedBranches) === status &&
        (!branches || branches.has(worktree.branch)),
    )
    .map(({ worktree }) => worktree.branch);
}

/**
 * Order the sidebar: roots first, each followed by what was branched from it.
 *
 * The final pass over every worktree is not redundant. A cycle in `baseBranch`
 * (which the outside world can produce — git does not forbid it) would leave
 * rows unvisited by the recursive walk, and `visited` makes the second pass
 * append exactly those, at depth 0. Without it a worktree can silently vanish
 * from the list.
 */
export function buildWorktreeListRows(worktrees: WorktreeInfo[]): WorktreeListRow[] {
  const worktreesByBranch = new Map(worktrees.map((worktree) => [worktree.branch, worktree]));
  const childrenByParent = new Map<string, WorktreeInfo[]>();
  const roots: WorktreeInfo[] = [];

  for (const worktree of worktrees) {
    const parentBranch = parentBranchOf(worktree, worktreesByBranch);
    if (!parentBranch) {
      roots.push(worktree);
      continue;
    }

    const siblings = childrenByParent.get(parentBranch) ?? [];
    siblings.push(worktree);
    childrenByParent.set(parentBranch, siblings);
  }

  const rows: WorktreeListRow[] = [];
  const visited = new Set<string>();

  function append(worktree: WorktreeInfo, depth: number): void {
    if (visited.has(worktree.branch)) return;
    visited.add(worktree.branch);
    rows.push({ worktree, depth });

    for (const child of childrenByParent.get(worktree.branch) ?? []) {
      append(child, depth + 1);
    }
  }

  for (const root of roots) {
    append(root, 0);
  }

  for (const worktree of worktrees) {
    append(worktree, 0);
  }

  return rows;
}
