import { allocateServicePorts } from '../../runtime/services.js';
import {
  buildProjectSessionName,
  buildWorktreeParkingWindowName,
  buildWorktreeWindowName,
} from '../../runtime/tmux/names.js';
import type {
  AutoRemoveCandidateResult,
  BranchPullRequestStates,
} from '../../runtime/worktree/gc.js';
import { type ManagedWorktree, WorktreeError } from '../../runtime/worktree/lifecycle.js';
import { withWorktreeBranchLock } from '../../runtime/worktree/lock.js';
import {
  findLatestRunIdForIssue,
  stopAgentSessionsForWorktree,
} from '../../storage/db/repository.js';
import type { CustomAgentDefinition } from '../custom.js';
import type { ResolvedAgentSessionContext } from './context.js';
import {
  AgentSessionError,
  generateFreeSessionBranch,
  listAgentSessions,
  type OpenedAgentSession,
  openAgentSession,
  stopAgentSession,
} from './open.js';
import { isLiveSession } from './types.js';

/**
 * Operations that cross the AgentSession / RuntimeSession boundary.
 *
 * The worktree manager remains the authority for git and durable bindings; this
 * module only coordinates the live sessions that occupy a worktree. Both the
 * HTTP transport and the CLI call these functions so neither grows its own
 * order of "stop panes, then change the checkout" steps.
 */

export async function stopLiveSessions(
  context: ResolvedAgentSessionContext,
  branch: string,
): Promise<void> {
  await withContextWorktreeLock(context, branch, async () => {
    const worktree = await requireManagedWorktree(context, branch);
    const sessions = (await listAgentSessions(context.storage, { branch })).filter(
      (session) => session.worktreeId === worktree.binding.worktreeId && isLiveSession(session),
    );
    for (const session of sessions) await stopAgentSession(context.deps, session);
    const remaining = (await listAgentSessions(context.storage, { branch })).filter(
      (session) => session.worktreeId === worktree.binding.worktreeId && isLiveSession(session),
    );
    if (remaining.length > 0) {
      throw new AgentSessionError(
        `Worktree ${branch} still has ${remaining.length} live agent session(s).`,
        409,
      );
    }
  });
}

type OwnedWorktree = ManagedWorktree & {
  entry: NonNullable<ManagedWorktree['entry']>;
  binding: NonNullable<ManagedWorktree['binding']>;
};

function withContextWorktreeLock<T>(
  context: ResolvedAgentSessionContext,
  branch: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withWorktreeBranchLock(context.projectId, branch, operation, {
    lockDir: context.deps.worktreeLockDir,
  });
}

async function requireManagedWorktree(
  context: ResolvedAgentSessionContext,
  branch: string,
  expected?: { path: string; worktreeId: string },
): Promise<OwnedWorktree> {
  const worktree = (await context.worktrees.list()).find((entry) => entry.branch === branch);
  if (worktree === undefined || worktree.entry === null) {
    throw new WorktreeError(`Worktree not found: ${branch}`, 404);
  }
  if (worktree.state !== 'managed' || worktree.binding === null) {
    throw new WorktreeError(`Worktree is not managed: ${branch}`, 409);
  }
  if (
    expected !== undefined &&
    (worktree.path !== expected.path || worktree.binding.worktreeId !== expected.worktreeId)
  ) {
    throw new WorktreeError(`Worktree identity changed since the prune plan: ${branch}`, 409);
  }
  return worktree as OwnedWorktree;
}

/**
 * Remove the whole worktree window and prove it is absent before git runs.
 *
 * `stopAgentSession` deliberately treats tmux failure as best effort for an
 * ordinary stop. Destructive worktree actions need the stricter contract: a
 * failed or lingering pane may still be writing to the checkout, so neither
 * merge nor removal may continue. Session rows move to `stopped` only after
 * tmux has confirmed the window is gone.
 */
export async function shutdownWorktreeSessionsStrict(
  context: ResolvedAgentSessionContext,
  branch: string,
): Promise<void> {
  const sessionName = buildProjectSessionName(context.projectId);
  const windowName = buildWorktreeWindowName(branch);
  const worktree = await requireManagedWorktree(context, branch);
  const live = (await listAgentSessions(context.storage, { branch })).filter(
    (session) => session.worktreeId === worktree.binding.worktreeId && isLiveSession(session),
  );
  const parkingWindow = buildWorktreeParkingWindowName(worktree.binding.worktreeId);
  const stablePanes = live.flatMap((session) =>
    session.paneTarget?.startsWith('%') === true ? [session.paneTarget] : [],
  );

  // Query every window before the first destructive operation. A transport
  // failure here is "unknown", not "absent", and must leave every process
  // untouched so merge/remove cannot race a surviving writer.
  if (context.deps.tmux.hasWindowStrict !== undefined) {
    await Promise.all([
      context.deps.tmux.hasWindowStrict(sessionName, windowName),
      context.deps.tmux.hasWindowStrict(sessionName, parkingWindow),
    ]);
  } else {
    await Promise.all([
      context.deps.tmux.hasWindow(sessionName, windowName),
      context.deps.tmux.hasWindow(sessionName, parkingWindow),
    ]);
  }
  if (stablePanes.length > 0) {
    if (
      context.deps.tmux.hasPaneStrict === undefined ||
      context.deps.tmux.getPaneIdentity === undefined ||
      context.deps.tmux.killPaneStrict === undefined
    ) {
      throw new AgentSessionError('The tmux gateway cannot safely stop worktree tab panes.', 501);
    }
    for (const paneId of stablePanes) {
      if (!(await context.deps.tmux.hasPaneStrict(paneId))) continue;
      const owner = await context.deps.tmux.getPaneIdentity(paneId);
      const row = live.find((session) => session.paneTarget === paneId);
      if (
        owner.sessionName !== sessionName ||
        (owner.windowName !== windowName && owner.windowName !== parkingWindow) ||
        row?.paneToken === null ||
        owner.ownerToken !== row?.paneToken
      ) {
        throw new AgentSessionError(
          `Pane ${paneId} no longer belongs to worktree ${branch}; shutdown was refused.`,
          409,
        );
      }
    }
    // Validate every target before the first destructive call. A stale id in
    // the middle cannot leave half the worktree stopped.
    for (const paneId of stablePanes) {
      if (await context.deps.tmux.hasPaneStrict(paneId)) {
        const owner = await context.deps.tmux.getPaneIdentity(paneId);
        const row = live.find((session) => session.paneTarget === paneId);
        if (
          owner.sessionName !== sessionName ||
          (owner.windowName !== windowName && owner.windowName !== parkingWindow) ||
          row?.paneToken === null ||
          owner.ownerToken !== row?.paneToken
        ) {
          throw new AgentSessionError(
            `Pane ownership changed for ${paneId}; shutdown refused.`,
            409,
          );
        }
        await context.deps.tmux.killPaneStrict(paneId);
      }
    }
  }
  if (context.deps.tmux.killWindowStrict !== undefined) {
    await context.deps.tmux.killWindowStrict(sessionName, windowName);
    // The namespace derives from this exact worktree id, so even a pane whose
    // row is orphaned is proven to belong to this teardown.
    await context.deps.tmux.killWindowStrict(sessionName, parkingWindow);
  } else {
    // Compatibility seam for injected gateways. Production always supplies the
    // strict primitive; a fake still has to prove absence before this returns.
    if (await context.deps.tmux.hasWindow(sessionName, windowName)) {
      await context.deps.tmux.killWindow(sessionName, windowName);
    }
    if (await context.deps.tmux.hasWindow(sessionName, windowName)) {
      throw new AgentSessionError(
        `Tmux window ${sessionName}:${windowName} is still running; the worktree was not changed.`,
        409,
      );
    }
    if (await context.deps.tmux.hasWindow(sessionName, parkingWindow)) {
      await context.deps.tmux.killWindow(sessionName, parkingWindow);
      if (await context.deps.tmux.hasWindow(sessionName, parkingWindow)) {
        throw new AgentSessionError(
          `Tmux parking window ${sessionName}:${parkingWindow} is still running; the worktree was not changed.`,
          409,
        );
      }
    }
  }
  const now = context.deps.now ?? (() => new Date());
  await stopAgentSessionsForWorktree(
    context.storage,
    worktree.binding.worktreeId,
    now().toISOString(),
  );
}

async function assertWorktreeWindowAbsent(
  context: ResolvedAgentSessionContext,
  branch: string,
): Promise<void> {
  const sessionName = buildProjectSessionName(context.projectId);
  const windowName = buildWorktreeWindowName(branch);
  const present =
    context.deps.tmux.hasWindowStrict === undefined
      ? await context.deps.tmux.hasWindow(sessionName, windowName)
      : await context.deps.tmux.hasWindowStrict(sessionName, windowName);
  if (present) throw new WorktreeError(`Worktree is open in tmux: ${branch}`, 409);
}

export async function removeManagedWorktree(
  context: ResolvedAgentSessionContext,
  branch: string,
): Promise<void> {
  await withContextWorktreeLock(context, branch, async () => {
    await requireManagedWorktree(context, branch);
    await shutdownWorktreeSessionsStrict(context, branch);
    await context.worktrees.remove(branch);
  });
}

export interface AutoRemoveManagedWorktreeInput {
  expected: { path: string; worktreeId: string };
  /** Fresh authoritative evidence, loaded while the branch mutation lock is held. */
  pullRequestEvidence: () => Promise<BranchPullRequestStates | null>;
}

/**
 * Destructive, locked GC gate.
 *
 * The scheduler's first PR scan is only a plan. Branch names can be reused and
 * a checkout can become dirty before that plan executes, so this operation
 * proves the durable worktree identity again, stops writers, reloads merge
 * evidence, compares the current HEAD with the merged PR's actual head commit,
 * and only then removes through the lifecycle manager under the same lock.
 */
export async function autoRemoveManagedWorktree(
  context: ResolvedAgentSessionContext,
  branch: string,
  input: AutoRemoveManagedWorktreeInput,
): Promise<AutoRemoveCandidateResult> {
  return withContextWorktreeLock(context, branch, async () => {
    try {
      await requireManagedWorktree(context, branch, input.expected);
    } catch (error) {
      if (error instanceof WorktreeError && (error.status === 404 || error.status === 409)) {
        return 'identity-changed';
      }
      throw error;
    }

    // Avoid stopping a live session for a candidate that is already known to
    // be unsafe. The same checks run again after shutdown; this first pass is
    // an effect-free guard, not the destructive proof.
    const initialEvidence = await input.pullRequestEvidence();
    if (initialEvidence === null) return 'inconclusive';
    const initialBranchEvidence = initialEvidence.get(branch);
    if (initialBranchEvidence === undefined || initialBranchEvidence.length === 0) {
      return 'no-pull-request';
    }
    if (!initialBranchEvidence.every((pullRequest) => pullRequest.state === 'merged')) {
      return 'not-merged';
    }
    const initialStatus = await context.worktrees.status(branch);
    if (initialStatus.dirty) return 'dirty';
    if (
      initialStatus.currentCommit === null ||
      !initialBranchEvidence.some(
        (pullRequest) =>
          pullRequest.currentRepository && pullRequest.headCommit === initialStatus.currentCommit,
      )
    ) {
      return 'head-mismatch';
    }

    await shutdownWorktreeSessionsStrict(context, branch);

    try {
      await requireManagedWorktree(context, branch, input.expected);
    } catch (error) {
      if (error instanceof WorktreeError && (error.status === 404 || error.status === 409)) {
        return 'identity-changed';
      }
      throw error;
    }

    const allEvidence = await input.pullRequestEvidence();
    if (allEvidence === null) return 'inconclusive';
    const evidence = allEvidence.get(branch);
    if (evidence === undefined || evidence.length === 0) return 'no-pull-request';
    if (!evidence.every((pullRequest) => pullRequest.state === 'merged')) return 'not-merged';

    // This read is deliberately last. With the agent windows now absent and
    // the branch lock still held, no canonical writer can alter the checkout
    // between this status/identity proof and lifecycle removal.
    const status = await context.worktrees.status(branch);
    if (status.dirty) return 'dirty';
    if (
      status.currentCommit === null ||
      !evidence.some(
        (pullRequest) =>
          pullRequest.currentRepository && pullRequest.headCommit === status.currentCommit,
      )
    ) {
      return 'head-mismatch';
    }

    await context.worktrees.remove(branch);
    return 'removed';
  });
}

export async function mergeManagedWorktree(
  context: ResolvedAgentSessionContext,
  branch: string,
): Promise<void> {
  await withContextWorktreeLock(context, branch, async () => {
    await requireManagedWorktree(context, branch);
    if ((await context.worktrees.status(branch)).dirty) {
      throw new WorktreeError(`Worktree has uncommitted changes: ${branch}`, 409);
    }
    await shutdownWorktreeSessionsStrict(context, branch);
    await context.worktrees.merge(branch);
  });
}

export async function setManagedWorktreeArchived(
  context: ResolvedAgentSessionContext,
  branch: string,
  archived: boolean,
): Promise<void> {
  await withContextWorktreeLock(context, branch, async () => {
    const worktree = await requireManagedWorktree(context, branch);
    if (!archived) {
      await context.worktrees.setArchived(branch, false);
      return;
    }

    // Persist before stopping the window: a database failure must leave a live
    // session completely untouched. If shutdown itself fails, restore the
    // exact previous curation value while the branch lock is still held.
    await context.worktrees.setArchived(branch, true);
    try {
      await shutdownWorktreeSessionsStrict(context, branch);
    } catch (error) {
      try {
        await context.worktrees.setArchived(branch, worktree.binding.archived ?? false);
      } catch (rollbackError) {
        const original = error instanceof Error ? error.message : String(error);
        const rollback =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new WorktreeError(`${original}; archive rollback failed: ${rollback}`, 500);
      }
      throw error;
    }
  });
}

export async function setManagedWorktreeLabel(
  context: ResolvedAgentSessionContext,
  branch: string,
  label: string | null,
): Promise<void> {
  await withContextWorktreeLock(context, branch, async () => {
    await requireManagedWorktree(context, branch);
    await context.worktrees.setLabel(branch, label);
  });
}

export interface OpenManagedWorktreesInput {
  agents: readonly string[];
  customAgents?: Readonly<Record<string, CustomAgentDefinition>>;
  mode?: 'new' | 'existing';
  branch?: string;
  baseBranch?: string;
  profile?: string;
  prompt?: string;
  envOverrides?: Readonly<Record<string, string>>;
  issueRef?: string;
  source?: 'ui' | 'oneshot';
}

export interface OpenManagedWorktreesOptions {
  initial: ResolvedAgentSessionContext;
  resolveContext: () => Promise<ResolvedAgentSessionContext>;
  open?: typeof openAgentSession;
  stop?: typeof stopAgentSession;
}

export interface OpenManagedWorktreesResult {
  primaryBranch: string;
  branches: string[];
}

/**
 * Open one or several agent worktrees as one transaction.
 *
 * Target derivation and rollback live here rather than in HTTP or CLI. A
 * generated base is resolved exactly once, duplicate agents collapse before
 * names are derived, and rollback removes only checkouts this call created.
 */
export async function openManagedWorktrees(
  options: OpenManagedWorktreesOptions,
  input: OpenManagedWorktreesInput,
): Promise<OpenManagedWorktreesResult> {
  const agents = [...new Set(input.agents)];
  if (agents.length === 0) throw new AgentSessionError('At least one agent is required.', 400);
  const mode = input.mode ?? 'new';
  if (mode === 'existing' && agents.length > 1) {
    throw new AgentSessionError(
      'Creating multiple agents is only supported for new worktrees.',
      400,
    );
  }
  if (mode === 'existing' && input.branch === undefined) {
    throw new AgentSessionError('Existing branch is required.', 400);
  }

  const baseBranch = input.branch ?? generateFreeSessionBranch(input.prompt);
  const targets = agents.map((agent) => ({
    agent,
    branch: agents.length === 1 ? baseBranch : `${agent}-${baseBranch}`,
  }));
  const runId =
    input.issueRef === undefined
      ? null
      : await findLatestRunIdForIssue({
          ...options.initial.storage,
          issueId: input.issueRef,
        });
  if (input.issueRef !== undefined && runId === null) {
    throw new AgentSessionError(`Issue ${input.issueRef} has no run to attach to.`, 409);
  }

  const opener = options.open ?? openAgentSession;
  const stopper = options.stop ?? stopAgentSession;
  const opened: Array<{
    result: OpenedAgentSession;
    context: ResolvedAgentSessionContext;
  }> = [];
  try {
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index] as (typeof targets)[number];
      const context = index === 0 ? options.initial : await options.resolveContext();
      const allocatedPorts = allocateServicePorts(
        (await context.worktrees.list()).map((worktree) => ({
          allocatedPorts: worktree.binding?.allocatedPorts ?? {},
        })),
        context.services,
      );
      const result = await opener(context.deps, {
        provider: target.agent,
        ...(input.customAgents?.[target.agent] === undefined
          ? {}
          : { customAgent: input.customAgents[target.agent] }),
        permission: 'workspace',
        mode,
        branch: target.branch,
        ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(Object.keys(context.startupEnv).length === 0 &&
        Object.keys(input.envOverrides ?? {}).length === 0
          ? {}
          : {
              startupEnvValues: {
                ...context.startupEnv,
                ...input.envOverrides,
              },
            }),
        ...(Object.keys(allocatedPorts).length === 0 ? {} : { allocatedPorts }),
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(runId === null ? {} : { runId }),
      });
      opened.push({ result, context });
    }
  } catch (error) {
    const cleanupErrors: string[] = [];
    for (const { result, context } of [...opened].reverse()) {
      try {
        await stopper(context.deps, result.session);
      } catch (cleanupError) {
        cleanupErrors.push(
          `session cleanup for ${result.branch} failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
      if (!result.worktreeCreated) continue;
      try {
        await withContextWorktreeLock(context, result.branch, () =>
          context.worktrees.remove(result.branch, {
            keepBranch: !result.branchCreated,
          }),
        );
      } catch (cleanupError) {
        cleanupErrors.push(
          `worktree cleanup for ${result.branch} failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
    if (cleanupErrors.length === 0) throw error;
    const original = error instanceof Error ? error.message : String(error);
    const status = error instanceof AgentSessionError ? error.status : 500;
    throw new AgentSessionError(`${original}; ${cleanupErrors.join('; ')}`, status);
  }

  return {
    primaryBranch: opened[0]?.result.branch ?? '',
    branches: opened.map(({ result }) => result.branch),
  };
}

export async function setManagedWorktreeProfile(
  context: ResolvedAgentSessionContext,
  branch: string,
  profile: string,
  resolveContext: () => Promise<ResolvedAgentSessionContext>,
  customAgent?: CustomAgentDefinition,
): Promise<{ restarted: boolean }> {
  return withContextWorktreeLock(context, branch, async () => {
    const owned = await requireManagedWorktree(context, branch);
    const branchSessions = (await listAgentSessions(context.storage, { branch })).filter(
      (session) => session.worktreeId === owned.binding.worktreeId,
    );
    if (
      branchSessions.some(
        (session) => session.parentSessionId !== null && session.status !== 'stopped',
      )
    ) {
      throw new WorktreeError(
        `Close every fork tab before changing the profile of ${branch}.`,
        409,
      );
    }
    const live =
      branchSessions.find(
        (session) => session.id === owned.binding.activeAgentSessionId && isLiveSession(session),
      ) ??
      branchSessions.find(
        (session) =>
          session.parentSessionId === null && session.tabSequence === 0 && isLiveSession(session),
      ) ??
      null;
    await context.worktrees.setProfile(branch, profile);
    if (live === null) return { restarted: false };
    await stopLiveSessions(context, branch);
    const next = await resolveContext();
    await openAgentSession(next.deps, {
      provider: live.provider,
      ...(customAgent === undefined ? {} : { customAgent }),
      permission: live.permission,
      branch,
      preferredSessionId: live.id,
      ...(live.runId === null ? {} : { runId: live.runId }),
      ...(live.phase === null ? {} : { phase: live.phase }),
      ...(live.storyId === null ? {} : { storyId: live.storyId }),
    });
    return { restarted: true };
  });
}

export interface PrunableWorktree {
  branch: string;
  path: string;
  worktreeId: string;
}

/**
 * Closed, git-backed worktrees are the only prune candidates.
 *
 * This is a plan, not a mutation. Keeping discovery separate is what makes the
 * CLI's default invocation a real dry run rather than output reconstructed
 * after deletion.
 */
export async function planClosedWorktreePrune(
  context: ResolvedAgentSessionContext,
): Promise<PrunableWorktree[]> {
  const [managed, sessions] = await Promise.all([
    context.worktrees.list(),
    listAgentSessions(context.storage),
  ]);
  const candidates = managed.filter(
    (entry): entry is OwnedWorktree =>
      entry.state === 'managed' &&
      entry.binding !== null &&
      entry.entry !== null &&
      !sessions.some(
        (session) => session.worktreeId === entry.binding?.worktreeId && isLiveSession(session),
      ),
  );
  const clean = await Promise.all(
    candidates.map(async (entry) => ({
      entry,
      dirty: (await context.worktrees.status(entry.branch)).dirty,
      open: await (async () => {
        try {
          await assertWorktreeWindowAbsent(context, entry.branch);
          return false;
        } catch (error) {
          if (error instanceof WorktreeError && error.status === 409) return true;
          throw error;
        }
      })(),
    })),
  );
  return clean
    .filter(({ dirty, open }) => !dirty && !open)
    .map(({ entry }) => ({
      branch: entry.branch,
      path: entry.path,
      worktreeId: entry.binding.worktreeId,
    }));
}

export interface PruneClosedWorktreesResult {
  removed: string[];
  failed: Array<{ branch: string; error: string }>;
}

/** Apply a previously displayed prune plan through the canonical remove path. */
export async function pruneClosedWorktrees(
  context: ResolvedAgentSessionContext,
  plan: readonly PrunableWorktree[],
): Promise<PruneClosedWorktreesResult> {
  const result: PruneClosedWorktreesResult = { removed: [], failed: [] };
  for (const candidate of plan) {
    try {
      await withContextWorktreeLock(context, candidate.branch, async () => {
        await requireManagedWorktree(context, candidate.branch, candidate);
        const live = (await listAgentSessions(context.storage, { branch: candidate.branch })).some(
          isLiveSession,
        );
        if (live) throw new WorktreeError(`Worktree is open: ${candidate.branch}`, 409);
        await assertWorktreeWindowAbsent(context, candidate.branch);
        if ((await context.worktrees.status(candidate.branch)).dirty) {
          throw new WorktreeError(`Worktree has uncommitted changes: ${candidate.branch}`, 409);
        }
        // Identity, DB liveness and physical liveness are re-read while the
        // same lock excludes `openAgentSession`. The manager then performs its
        // own final git existence check before removal.
        await requireManagedWorktree(context, candidate.branch, candidate);
        const reopened = (
          await listAgentSessions(context.storage, { branch: candidate.branch })
        ).some(isLiveSession);
        if (reopened) throw new WorktreeError(`Worktree reopened: ${candidate.branch}`, 409);
        await assertWorktreeWindowAbsent(context, candidate.branch);
        if ((await context.worktrees.status(candidate.branch)).dirty) {
          throw new WorktreeError(`Worktree became dirty: ${candidate.branch}`, 409);
        }
        await context.worktrees.remove(candidate.branch);
      });
      result.removed.push(candidate.branch);
    } catch (error) {
      result.failed.push({
        branch: candidate.branch,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
