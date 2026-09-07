/**
 * How tmux sessions, windows and panes are named.
 *
 * Ported from the naming helpers of WebMux `backend/src/adapters/tmux.ts`
 * @ d8c9d5f. Pure functions, so the characterization tests can compare names
 * without a tmux server anywhere.
 *
 * One deliberate change (§13, change 3): the session is keyed by Issue Flow's
 * **project id** rather than by a hash of the path. The project id is derived
 * from the git remote (`storage/project-identity.ts`), so it survives moving the
 * directory and is identical across two clones of the same repository — which
 * is exactly what a session name should be stable against. The upstream hashes
 * the path because it has no other identity available.
 */

/** Prefix of everything this project creates in tmux. */
export const TMUX_NAME_PREFIX = 'if';

/**
 * Reduce a value to what tmux accepts in a name.
 *
 * tmux treats `:` and `.` as target separators, so a name carrying them turns
 * `session:window.pane` into something that resolves elsewhere. Everything
 * outside the safe set collapses to a single dash, and an empty result becomes
 * `x` rather than an empty segment that would produce `if--<hash>`.
 */
export function sanitizeTmuxNameSegment(value: string, maxLength = 24): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  const trimmed = sanitized.slice(0, maxLength);
  return trimmed === '' ? 'x' : trimmed;
}

/**
 * One tmux session per project.
 *
 * `projectId` already ends in a hash of the remote (or of the absolute path when
 * there is none), so two projects never collide and the same project keeps its
 * session after being moved.
 */
export function buildProjectSessionName(projectId: string): string {
  return `${TMUX_NAME_PREFIX}-${sanitizeTmuxNameSegment(projectId, 32)}`;
}

/** One window per worktree, named after its branch. */
export function buildWorktreeWindowName(branch: string): string {
  return `${TMUX_NAME_PREFIX}-${sanitizeTmuxNameSegment(branch, 40)}`;
}

/**
 * Hidden window holding a worktree's parked (inactive) panes.
 *
 * `ifp-` is a disjoint namespace from every visible `if-` window, so a branch
 * such as `foo-parked` can never alias another worktree's parking window.
 */
export function buildWorktreeParkingWindowName(worktreeId: string): string {
  const digest = createHash('sha256').update(worktreeId).digest('hex').slice(0, 12);
  return `ifp-${sanitizeTmuxNameSegment(worktreeId, 18)}-${digest}`;
}

/** `session:window.pane`, the only form tmux targets are built in. */
export function buildPaneTarget(
  sessionName: string,
  windowName: string,
  paneIndex: number,
): string {
  return `${sessionName}:${windowName}.${paneIndex}`;
}

export interface TmuxWindowSummary {
  sessionName: string;
  windowName: string;
  paneCount: number;
}

/**
 * Parse the tab-separated output of `list-windows -a`.
 *
 * The separator is a TAB, which is why `locale.ts` exists: under a non-UTF-8
 * locale tmux rewrites it as `_` and every line here silently fails to split,
 * dropping every window.
 */
export function parseWindowSummaries(output: string): TmuxWindowSummary[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sessionName = '', windowName = '', paneCountRaw = '0'] = line.split('\t');
      return {
        sessionName,
        windowName,
        paneCount: Number.parseInt(paneCountRaw, 10) || 0,
      };
    })
    .filter((entry) => entry.sessionName.length > 0 && entry.windowName.length > 0);
}

import { createHash } from 'node:crypto';

/** Grouped terminal viewers share owner windows but never own runtime panes. */
export const VIEWER_SESSION_PREFIX = 'if-view';
