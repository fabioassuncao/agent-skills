import type { Readable, Writable } from 'node:stream';
import type { ResolvedAgentSessionContext } from '../agents/session/context.js';
import { resolveAgentSessionDeps } from '../agents/session/context.js';
import { listAgentSessions } from '../agents/session/open.js';
import { refreshActiveAgentTab } from '../agents/session/tabs.js';
import { isLiveSession } from '../agents/session/types.js';
import {
  mergeManagedWorktree,
  planClosedWorktreePrune,
  pruneClosedWorktrees,
  removeManagedWorktree,
  setManagedWorktreeArchived,
  setManagedWorktreeLabel,
} from '../agents/session/worktree-control.js';
import type { ManagedWorktree } from '../runtime/worktree/lifecycle.js';
import { printError, printInfo } from '../ui/logger.js';
import { isInteractive, promptConfirm } from '../ui/prompts.js';

/**
 * Direct CLI control for managed worktrees.
 *
 * Like `session` and `project`, this talks to the durable/runtime authorities
 * without requiring the monitor. Mutations delegate to `worktree-control`, the
 * same cross-session layer used by the HTTP routes.
 */

export interface WorktreeCommandDeps {
  resolveContext?: (options: { projectRoot?: string }) => Promise<ResolvedAgentSessionContext>;
  log?: (message: string) => void;
  /** Machine-readable stdout, without logger icons or diagnostic publication. */
  raw?: (message: string) => void;
  error?: (message: string) => void;
  interactive?: boolean;
  stdin?: Readable;
  stdout?: Writable;
  confirm?: (message: string) => Promise<boolean>;
  setArchived?: typeof setManagedWorktreeArchived;
  setLabel?: typeof setManagedWorktreeLabel;
  remove?: typeof removeManagedWorktree;
  merge?: typeof mergeManagedWorktree;
  planPrune?: typeof planClosedWorktreePrune;
  applyPrune?: typeof pruneClosedWorktrees;
  listRows?: typeof listWorktreeRows;
  refreshTerminal?: typeof refreshActiveAgentTab;
}

interface ResolvedDeps {
  resolveContext: (options: { projectRoot?: string }) => Promise<ResolvedAgentSessionContext>;
  log: (message: string) => void;
  raw: (message: string) => void;
  error: (message: string) => void;
  interactive?: boolean;
  stdin?: Readable;
  stdout?: Writable;
  confirm?: (message: string) => Promise<boolean>;
  setArchived: typeof setManagedWorktreeArchived;
  setLabel: typeof setManagedWorktreeLabel;
  remove: typeof removeManagedWorktree;
  merge: typeof mergeManagedWorktree;
  planPrune: typeof planClosedWorktreePrune;
  applyPrune: typeof pruneClosedWorktrees;
  listRows: typeof listWorktreeRows;
  refreshTerminal: typeof refreshActiveAgentTab;
}

function resolveDeps(deps: WorktreeCommandDeps): ResolvedDeps {
  return {
    resolveContext: deps.resolveContext ?? ((options) => resolveAgentSessionDeps(options)),
    log: deps.log ?? printInfo,
    raw: deps.raw ?? ((message) => process.stdout.write(`${message}\n`)),
    error: deps.error ?? printError,
    ...(deps.interactive === undefined ? {} : { interactive: deps.interactive }),
    ...(deps.stdin === undefined ? {} : { stdin: deps.stdin }),
    ...(deps.stdout === undefined ? {} : { stdout: deps.stdout }),
    ...(deps.confirm === undefined ? {} : { confirm: deps.confirm }),
    setArchived: deps.setArchived ?? setManagedWorktreeArchived,
    setLabel: deps.setLabel ?? setManagedWorktreeLabel,
    remove: deps.remove ?? removeManagedWorktree,
    merge: deps.merge ?? mergeManagedWorktree,
    planPrune: deps.planPrune ?? planClosedWorktreePrune,
    applyPrune: deps.applyPrune ?? pruneClosedWorktrees,
    listRows: deps.listRows ?? listWorktreeRows,
    refreshTerminal: deps.refreshTerminal ?? refreshActiveAgentTab,
  };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function contextFor(
  project: string | undefined,
  deps: ResolvedDeps,
): Promise<ResolvedAgentSessionContext> {
  return deps.resolveContext(project === undefined ? {} : { projectRoot: project });
}

async function authorizeLoss(
  message: string,
  yes: boolean | undefined,
  deps: ResolvedDeps,
): Promise<boolean> {
  if (yes === true) return true;
  if (deps.confirm !== undefined) return deps.confirm(message);
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const interactive = deps.interactive ?? isInteractive({ stdin, stdout, ci: process.env.CI });
  if (!interactive) {
    deps.error('This operation removes a worktree. Re-run with --yes to confirm.');
    return false;
  }
  const result = await promptConfirm({ message, initialValue: false, stdin, stdout });
  return result.status !== 'cancelled' && result.value === true;
}

export interface WorktreeProjectOptions {
  project?: string;
  json?: boolean;
}

/** Non-destructive: attach to the live pane, or resume the same conversation if it died. */
export async function runWorktreeRefresh(
  branch: string,
  options: WorktreeProjectOptions = {},
  deps: WorktreeCommandDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps);
  try {
    const context = await contextFor(options.project, resolved);
    const result = await resolved.refreshTerminal(context, branch);
    if (options.json === true) {
      resolved.raw(JSON.stringify({ ok: true, branch, ...result }));
    } else {
      resolved.log(
        `${result.mode === 'reattach' ? 'Reattached' : 'Resumed'} session ${result.sessionId} on ${branch}.`,
      );
    }
    return 0;
  } catch (error) {
    resolved.error(failureMessage(error));
    return 1;
  }
}

export interface WorktreeListOptions extends WorktreeProjectOptions {
  all?: boolean;
  archived?: boolean;
}

export interface WorktreeRow {
  branch: string;
  label: string | null;
  path: string;
  state: ManagedWorktree['state'];
  archived: boolean;
  live: boolean;
}

export async function listWorktreeRows(
  context: ResolvedAgentSessionContext,
): Promise<WorktreeRow[]> {
  const [worktrees, sessions] = await Promise.all([
    context.worktrees.list(),
    listAgentSessions(context.storage),
  ]);
  return worktrees.map((worktree) => ({
    branch: worktree.branch,
    label: worktree.binding?.label ?? null,
    path: worktree.path,
    state: worktree.state,
    archived: worktree.binding?.archived ?? false,
    live:
      worktree.binding !== null &&
      sessions.some(
        (session) => session.worktreeId === worktree.binding?.worktreeId && isLiveSession(session),
      ),
  }));
}

function formatWorktreeRows(rows: readonly WorktreeRow[]): string[] {
  if (rows.length === 0) return ['No worktrees found.'];
  const branchWidth = Math.max('BRANCH / LABEL'.length, ...rows.map((row) => row.branch.length));
  return [
    `${'BRANCH / LABEL'.padEnd(branchWidth)}  STATUS           STATE       PATH`,
    ...rows.map((row) => {
      const name = row.label === null ? row.branch : `${row.label} (${row.branch})`;
      const status = `${row.live ? 'open' : 'closed'}${row.archived ? ', archived' : ''}`;
      return `${name.padEnd(branchWidth)}  ${status.padEnd(15)}  ${row.state.padEnd(10)}  ${row.path}`;
    }),
  ];
}

/** `worktree ls` includes closed and archived bindings that `session ls` cannot curate. */
export async function runWorktreeLs(
  options: WorktreeListOptions = {},
  deps: WorktreeCommandDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps);
  if (options.all === true && options.archived === true) {
    resolved.error('Use either --all or --archived, not both.');
    return 1;
  }
  try {
    const context = await contextFor(options.project, resolved);
    const allRows = await resolved.listRows(context);
    const rows = allRows.filter((row) => {
      if (options.all === true) return true;
      if (options.archived === true) return row.archived;
      return !row.archived;
    });
    if (options.json === true) {
      resolved.raw(
        JSON.stringify(
          { schemaVersion: 1, projectId: context.projectId, worktrees: rows },
          null,
          2,
        ),
      );
      return 0;
    }
    for (const line of formatWorktreeRows(rows)) resolved.log(line);
    return 0;
  } catch (error) {
    resolved.error(failureMessage(error));
    return 1;
  }
}

async function runArchiveChange(
  branch: string,
  archived: boolean,
  options: WorktreeProjectOptions,
  deps: WorktreeCommandDeps,
): Promise<number> {
  const resolved = resolveDeps(deps);
  try {
    const context = await contextFor(options.project, resolved);
    await resolved.setArchived(context, branch, archived);
    resolved.log(`${archived ? 'Archived' : 'Unarchived'} worktree ${branch}.`);
    return 0;
  } catch (error) {
    resolved.error(failureMessage(error));
    return 1;
  }
}

export function runWorktreeArchive(
  branch: string,
  options: WorktreeProjectOptions = {},
  deps: WorktreeCommandDeps = {},
): Promise<number> {
  return runArchiveChange(branch, true, options, deps);
}

export function runWorktreeUnarchive(
  branch: string,
  options: WorktreeProjectOptions = {},
  deps: WorktreeCommandDeps = {},
): Promise<number> {
  return runArchiveChange(branch, false, options, deps);
}

export interface WorktreeLabelOptions extends WorktreeProjectOptions {
  clear?: boolean;
}

export async function runWorktreeLabel(
  branch: string,
  label: string | undefined,
  options: WorktreeLabelOptions = {},
  deps: WorktreeCommandDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps);
  if (options.clear === true && label !== undefined) {
    resolved.error('Pass a label or --clear, not both.');
    return 1;
  }
  const normalized = options.clear === true ? null : (label?.trim() ?? '');
  if (normalized === '') {
    resolved.error('Pass a non-empty label or --clear.');
    return 1;
  }
  if (normalized !== null && normalized.length > 80) {
    resolved.error('A worktree label must be at most 80 characters.');
    return 1;
  }
  try {
    const context = await contextFor(options.project, resolved);
    await resolved.setLabel(context, branch, normalized);
    resolved.log(
      normalized === null
        ? `Cleared label for worktree ${branch}.`
        : `Labeled worktree ${branch} as "${normalized}".`,
    );
    return 0;
  } catch (error) {
    resolved.error(failureMessage(error));
    return 1;
  }
}

export interface DestructiveWorktreeOptions extends WorktreeProjectOptions {
  yes?: boolean;
}

export interface WorktreePruneOptions extends DestructiveWorktreeOptions {
  dryRun?: boolean;
}

export async function runWorktreeRemove(
  branch: string,
  options: DestructiveWorktreeOptions = {},
  deps: WorktreeCommandDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps);
  if (
    !(await authorizeLoss(
      `Remove worktree ${branch} and delete its branch? This cannot be undone.`,
      options.yes,
      resolved,
    ))
  ) {
    return 1;
  }
  try {
    const context = await contextFor(options.project, resolved);
    await resolved.remove(context, branch);
    resolved.log(`Removed worktree ${branch}.`);
    return 0;
  } catch (error) {
    resolved.error(failureMessage(error));
    return 1;
  }
}

export async function runWorktreeMerge(
  branch: string,
  options: DestructiveWorktreeOptions = {},
  deps: WorktreeCommandDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps);
  if (
    !(await authorizeLoss(
      `Merge ${branch} into the base branch and remove its worktree?`,
      options.yes,
      resolved,
    ))
  ) {
    return 1;
  }
  try {
    const context = await contextFor(options.project, resolved);
    await resolved.merge(context, branch);
    resolved.log(`Merged worktree ${branch} into ${context.mainBranch}.`);
    return 0;
  } catch (error) {
    resolved.error(failureMessage(error));
    return 1;
  }
}

/**
 * `worktree prune` is a dry run unless `--yes` is explicit.
 *
 * The plan is produced before confirmation and passed unchanged to the apply
 * call, so the printed branches are exactly the branches authorized for this
 * invocation.
 */
export async function runWorktreePrune(
  options: WorktreePruneOptions = {},
  deps: WorktreeCommandDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps);
  if (options.yes === true && options.dryRun === true) {
    resolved.error('Use either --dry-run or --yes, not both.');
    return 1;
  }
  try {
    const context = await contextFor(options.project, resolved);
    const plan = await resolved.planPrune(context);
    if (plan.length === 0) {
      resolved.log('No closed worktrees to prune.');
      return 0;
    }
    for (const candidate of plan)
      resolved.log(`Would prune ${candidate.branch} (${candidate.path})`);
    if (options.yes !== true) {
      resolved.log(
        `Dry run: ${plan.length} closed worktree${plan.length === 1 ? '' : 's'}. Re-run with --yes to remove them.`,
      );
      return 0;
    }
    const result = await resolved.applyPrune(context, plan);
    for (const branch of result.removed) resolved.log(`Pruned worktree ${branch}.`);
    for (const failure of result.failed)
      resolved.error(`Failed to prune ${failure.branch}: ${failure.error}`);
    return result.failed.length === 0 ? 0 : 1;
  } catch (error) {
    resolved.error(failureMessage(error));
    return 1;
  }
}
