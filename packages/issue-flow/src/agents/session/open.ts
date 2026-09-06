import { randomUUID } from 'node:crypto';
import { isValidBranchName, slugify } from '../../conventions/git/slug.js';
import type { PaneTemplate } from '../../runtime/profiles.js';
import { interruptPrompt, sendPrompt } from '../../runtime/terminal/input.js';
import type { TmuxGateway } from '../../runtime/tmux/gateway.js';
import {
  type EnsureSessionLayoutResult,
  ensureSessionLayout,
  isWorktreeOpen,
  planSessionLayout,
} from '../../runtime/tmux/layout.js';
import {
  buildPaneTarget,
  buildProjectSessionName,
  buildWorktreeWindowName,
} from '../../runtime/tmux/names.js';
import type { GitWorktreeGateway } from '../../runtime/worktree/git.js';
import type { CreatedWorktree, ManagedWorktree } from '../../runtime/worktree/lifecycle.js';
import { getWorktreeStoragePaths } from '../../runtime/worktree/paths.js';
import type { PlanRepositoryContext } from '../../storage/db/repository.js';
import {
  type AgentLaunchMode,
  buildManagedShellCommand,
  buildPaneCommand,
  buildTtyAgentArgv,
} from '../tty.js';
import type { AgentPermission, AgentPhase, AgentProviderId } from '../types.js';
import { canReuseSession, selectReusableSession } from './reuse.js';
import {
  createAgentSession,
  listSessions,
  recordPaneTarget,
  saveSession,
  updateSessionStatus,
} from './store.js';
import { type AgentSession, isFreeSession, isLiveSession } from './types.js';

/**
 * Opening an agent in a pane — with an issue behind it, or with nothing behind
 * it at all.
 *
 * §49 of the absorption plan calls these two modes, and ADR-16 is the reason
 * there is only one module for both: an `AgentSession` whose `runId`, `phase`
 * and `storyId` are empty *is* a free session. There is no second entity, no
 * second table and no second launch path — the fields a workflow fills in are
 * simply absent, and every consumer already had to tolerate that because the
 * columns were nullable from the day they were created.
 *
 * ADAPT of `createWorktree` / `openWorktree` in WebMux
 * `backend/src/services/lifecycle-service.ts` @ d8c9d5f, which is the upstream's
 * one-click "open an agent on a branch". Two upstream behaviours are kept
 * because dropping them changes what the feature is:
 *
 * - **the branch is generated when nobody names one** (`resolveBranch` →
 *   `generateFallbackBranchName`). Requiring a branch would be requiring the
 *   very ceremony a free session exists to skip;
 * - **reopening resumes rather than restarts** (`launchMode` from the stored
 *   conversation). Here it goes one step further than the upstream, which
 *   rebuilds the window unconditionally: `ensureSessionLayout` distinguishes
 *   `reattach` from `resume` (§27), so reopening a session whose agent is still
 *   working does not kill it.
 *
 * Three rules from §49.2 are enforced here and are the reason to read this file
 * before changing it:
 *
 * 1. **A free session never starts the pipeline.** Nothing in this module
 *    writes a `runs` row, publishes a snapshot or advances a phase. Promotion
 *    to mode 1 is a separate, explicit act (`linkSessionToRun`).
 * 2. **The pipeline never adopts a free session** (ADR-07 / ADR-16). The rule
 *    itself lives in `selectReusableSession`; this module only feeds it the
 *    phase it was asked for, and never works around the answer.
 * 3. **A free session never adopts the pipeline's conversation either.** The
 *    mirror image of rule 2, and the reason `candidateSessions` filters: a
 *    person opening a session on a branch a run is working on gets their own
 *    conversation, not a silent seat inside the run's.
 */

/** Failures a caller is expected to distinguish, with the HTTP status they map to. */
export class AgentSessionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AgentSessionError';
  }
}

/** Prefix every generated free-session branch carries. */
export const FREE_SESSION_BRANCH_PREFIX = 'session';

/** Longest slug taken from a label or prompt when generating a branch name. */
export const FREE_SESSION_SLUG_MAX = 32;

/**
 * The branch a free session works on when nobody named one.
 *
 * PORT of `generateFallbackBranchName` (`backend/src/lib/branch-name.ts`), with
 * the hint the upstream gets from its optional auto-namer folded in as a plain
 * slug. No model is consulted: naming a scratch branch must never cost a
 * round trip, and `session/` already says everything a reader needs.
 *
 * The random suffix is always present, even with a hint, because two sessions
 * labelled "debug" on the same day are the normal case, not the exception.
 */
export function generateFreeSessionBranch(hint?: string, suffix?: string): string {
  const unique = suffix ?? randomUUID().slice(0, 8);
  const slug = hint === undefined ? '' : slugify(hint, FREE_SESSION_SLUG_MAX);
  const name =
    slug === ''
      ? `${FREE_SESSION_BRANCH_PREFIX}/${unique}`
      : `${FREE_SESSION_BRANCH_PREFIX}/${slug}-${unique}`;
  // A slug is already sanitized, so this only ever fires for a pathological
  // suffix — and a generated name that git would refuse must never reach
  // `worktree add`, where the error names a path nobody recognises.
  return isValidBranchName(name) ? name : `${FREE_SESSION_BRANCH_PREFIX}/${unique}`;
}

/** The slice of the worktree manager this module needs. Narrow so tests can stub it. */
export interface WorktreeSlice {
  create(input: {
    branch: string;
    mode?: 'new' | 'existing';
    agent: string;
    profile?: string;
  }): Promise<CreatedWorktree>;
  list(): Promise<ManagedWorktree[]>;
  remove(branch: string, options?: { force?: boolean }): Promise<void>;
}

export interface AgentSessionDeps {
  /** Issue Flow's project id — what the tmux session is named after. */
  projectId: string;
  /** Repository root. Panes declaring `cwd: 'repo'` open here. */
  projectRoot: string;
  storage: PlanRepositoryContext;
  worktrees: WorktreeSlice;
  tmux: TmuxGateway;
  /** Resolves a worktree's git dir, so a reused worktree finds its runtime env. */
  git: Pick<GitWorktreeGateway, 'resolveWorktreeGitDir'>;
  /** Whether a local branch already exists — decides `new` vs `existing`. */
  branchExists(branch: string): Promise<boolean>;
  /** Pane templates of the resolved profile. */
  panes: readonly PaneTemplate[];
  /** Profile name, recorded on the worktree binding. */
  profileName: string;
  /**
   * Login shell the shell panes run. Defaults to `$SHELL`.
   *
   * Only the *path* is configurable: the command around it is built per
   * worktree, because it sources that worktree's runtime env — a shell pane
   * that did not would show none of the ports the agent beside it is using.
   */
  shellPath?: string;
  now?: () => Date;
}

export interface OpenAgentSessionInput {
  provider: AgentProviderId;
  permission: AgentPermission;
  /** Branch to work on. Generated when absent — that is what makes it *free*. */
  branch?: string;
  /** Caption for a session no issue names. */
  label?: string;
  /** First turn. Travels in the agent's argv (ADR-04), never through the TTY. */
  prompt?: string;
  systemPrompt?: string;
  model?: string | null;
  /** Present → mode 1 (workflow). Absent → mode 2 (free session). */
  runId?: string | null;
  phase?: AgentPhase | null;
  storyId?: string | null;
}

export interface OpenedAgentSession {
  session: AgentSession;
  branch: string;
  worktreePath: string;
  /** `session:window.pane` of the agent's own pane. Prompts go here. */
  paneTarget: string;
  layout: EnsureSessionLayoutResult;
  launchMode: AgentLaunchMode;
  /** Whether this call created the worktree, or found one already there. */
  worktreeCreated: boolean;
}

/**
 * Sessions a new one may continue.
 *
 * `selectReusableSession` owns the rule about *phases* (ADR-07) and is not
 * re-implemented here. What is added is its mirror image: an opening whose
 * phase is `null` — a free session — is offered only other free sessions. The
 * asymmetry would otherwise be real: the pipeline is forbidden from adopting a
 * person's conversation, while a person would silently inherit the pipeline's.
 */
function candidateSessions(
  sessions: readonly AgentSession[],
  phase: AgentPhase | null,
): AgentSession[] {
  return phase === null ? sessions.filter(isFreeSession) : [...sessions];
}

/**
 * Who owns the window this opening is about to land in.
 *
 * Two questions, and they are not the same one:
 *
 * - **resumable** — a session with a conversation to continue. That is
 *   `selectReusableSession`, and the ADR-07 rule lives there;
 * - **adoptable** — a session that owns the window, whether or not the provider
 *   has reported a conversation id yet. It matters because a *reattach* does
 *   not re-run the agent argv: the process already in that pane keeps running,
 *   so a second row created here would claim a pane it never started, and two
 *   rows would then send prompts to one agent.
 *
 * A live session nobody may adopt is why this returns a decision rather than a
 * session. Reattaching into somebody else's pane would hand a `review` the
 * conversation ADR-07 forbids it — through the window instead of through the
 * conversation id, which is the same violation wearing a different hat.
 */
function decideAdoption(
  sessions: readonly AgentSession[],
  input: { phase: AgentPhase | null; branch: string },
): { adopted: AgentSession | null; blockedBy: AgentSession | null } {
  const live = candidateSessions(sessions, input.phase).filter(isLiveSession);
  const resumable = selectReusableSession({ ...input, sessions: live });
  const adopted =
    resumable ??
    (canReuseSession(input.phase)
      ? ([...live].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null)
      : null);
  if (adopted !== null) return { adopted, blockedBy: null };

  // Nothing adoptable — but somebody live may still be sitting in the window.
  const occupant =
    sessions
      .filter(isLiveSession)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  return { adopted: null, blockedBy: occupant };
}

/** The pane the agent itself runs in — not necessarily the focused one. */
function agentPaneIndex(panes: readonly { kind: string; index: number }[]): number {
  return panes.find((pane) => pane.kind === 'agent')?.index ?? 0;
}

/**
 * Find the worktree for a branch, or make one.
 *
 * `existing` when git already knows the branch, `new` otherwise: the worktree
 * manager refuses the wrong mode with a 409 rather than guessing, so the mode
 * is decided here, from the one question that answers it.
 */
async function ensureWorktree(
  deps: AgentSessionDeps,
  branch: string,
  provider: AgentProviderId,
): Promise<{ path: string; worktreeId: string | null; runtimeEnvPath: string; created: boolean }> {
  const existing = (await deps.worktrees.list()).find(
    (worktree) => worktree.branch === branch && worktree.entry !== null,
  );
  if (existing !== undefined) {
    const gitDir = await deps.git.resolveWorktreeGitDir(existing.path);
    return {
      path: existing.path,
      worktreeId: existing.binding?.worktreeId ?? null,
      runtimeEnvPath: getWorktreeStoragePaths(gitDir).runtimeEnvPath,
      created: false,
    };
  }

  const created = await deps.worktrees.create({
    branch,
    mode: (await deps.branchExists(branch)) ? 'existing' : 'new',
    agent: provider,
    profile: deps.profileName,
  });
  return {
    path: created.path,
    worktreeId: created.worktreeId,
    runtimeEnvPath: created.runtimeEnvPath,
    created: true,
  };
}

/**
 * Open an agent session: a worktree, a tmux window, a pane running the agent,
 * and the row that binds the conversation to what it is for.
 *
 * Refuses without tmux instead of degrading. A "session" that quietly ran
 * headless would report an interactivity it never provided, and `headless`
 * itself is untouched by any of this — it is the default and it stays the
 * default (ADR-03).
 */
export async function openAgentSession(
  deps: AgentSessionDeps,
  input: OpenAgentSessionInput,
): Promise<OpenedAgentSession> {
  if (!(await deps.tmux.isAvailable())) {
    throw new AgentSessionError(
      'Opening an agent session needs tmux, which is not installed. Headless runs (`issue-flow run`) do not.',
      412,
    );
  }

  const requested = input.branch?.trim();
  if (requested !== undefined && requested !== '' && !isValidBranchName(requested)) {
    throw new AgentSessionError(`Invalid branch name: ${requested}`, 400);
  }
  const branch =
    requested === undefined || requested === ''
      ? generateFreeSessionBranch(input.label ?? input.prompt)
      : requested;

  const phase = input.phase ?? null;
  const worktree = await ensureWorktree(deps, branch, input.provider);

  const known = await listSessions(deps.storage, { branch });
  const { adopted, blockedBy } = decideAdoption(known, { phase, branch });
  if (
    adopted === null &&
    blockedBy !== null &&
    (await isWorktreeOpen(deps.tmux, deps.projectId, branch))
  ) {
    throw new AgentSessionError(
      `Branch ${branch} already has a live agent (session ${blockedBy.id}) in its window, and this one may not continue it. Stop that session first, or work on another branch.`,
      409,
    );
  }
  const launchMode: AgentLaunchMode =
    adopted !== null && adopted.conversationId !== null ? 'resume' : 'fresh';

  const argv = buildTtyAgentArgv({
    provider: input.provider,
    permission: input.permission,
    launchMode,
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
    ...(input.model === undefined || input.model === null ? {} : { model: input.model }),
    ...(launchMode === 'resume' && adopted?.conversationId
      ? { resumeConversationId: adopted.conversationId }
      : {}),
  });

  const plan = planSessionLayout({
    projectId: deps.projectId,
    branch,
    templates: [...deps.panes],
    context: {
      repoRoot: deps.projectRoot,
      worktreePath: worktree.path,
      paneCommands: {
        agent: buildPaneCommand({ argv, runtimeEnvPath: worktree.runtimeEnvPath }),
        shell: buildManagedShellCommand(worktree.runtimeEnvPath, deps.shellPath),
      },
    },
  });

  const layout = await ensureSessionLayout(deps.tmux, plan);
  const paneTarget = buildPaneTarget(plan.sessionName, plan.windowName, agentPaneIndex(plan.panes));

  // `reattach` means the window — and the agent inside it — was left running,
  // so the argv above was never executed and the prompt it carried never
  // arrived. Delivering it as a paste is the only way in, and it is exactly
  // what a subsequent turn already does.
  if (layout.mode === 'reattach' && input.prompt !== undefined && input.prompt !== '') {
    await sendPrompt(deps.tmux, paneTarget, input.prompt);
  }

  const now = deps.now ?? ((): Date => new Date());
  if (adopted !== null) {
    // The same conversation, continued for the same purpose: the binding it
    // already has is the binding, and minting a second row for it would split
    // one session's history in two.
    const session = await recordPaneTarget(deps.storage, adopted, paneTarget, now);
    return {
      session,
      branch,
      worktreePath: worktree.path,
      paneTarget,
      layout,
      launchMode,
      worktreeCreated: worktree.created,
    };
  }

  const session = createAgentSession({
    branch,
    provider: input.provider,
    worktreeId: worktree.worktreeId,
    paneTarget,
    status: 'starting',
    now,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(phase === null ? {} : { phase }),
    ...(input.storyId === undefined ? {} : { storyId: input.storyId }),
  });
  await saveSession(deps.storage, session);

  return {
    session,
    branch,
    worktreePath: worktree.path,
    paneTarget,
    layout,
    launchMode,
    worktreeCreated: worktree.created,
  };
}

/** Every session of the project, newest first. */
export async function listAgentSessions(
  storage: PlanRepositoryContext,
  filter: { branch?: string; runId?: string } = {},
): Promise<AgentSession[]> {
  return listSessions(storage, filter);
}

/** Only the ones a person opened for themselves (§49.4). */
export async function listFreeSessions(storage: PlanRepositoryContext): Promise<AgentSession[]> {
  return (await listSessions(storage)).filter(isFreeSession);
}

function requirePane(session: AgentSession): string {
  if (session.paneTarget === null) {
    throw new AgentSessionError(
      `Session ${session.id} is not attached to a pane, so there is nothing to type into.`,
      409,
    );
  }
  return session.paneTarget;
}

/**
 * Deliver a subsequent turn to a live session.
 *
 * Through the tmux buffer, never `send-keys -l`: a TUI with slash commands or
 * paste detection reacts halfway through a character-by-character delivery
 * (`runtime/terminal/input.ts`). The *first* turn never comes through here — it
 * travels in the argv.
 */
export async function sendToAgentSession(
  deps: Pick<AgentSessionDeps, 'tmux'>,
  session: AgentSession,
  text: string,
): Promise<void> {
  await sendPrompt(deps.tmux, requirePane(session), text);
}

/** Interrupt the agent, exactly as a person pressing Ctrl-C would. */
export async function interruptAgentSession(
  deps: Pick<AgentSessionDeps, 'tmux'>,
  session: AgentSession,
): Promise<void> {
  await interruptPrompt(deps.tmux, requirePane(session));
}

export interface StopAgentSessionOptions {
  /** Also remove the worktree and its branch. Off by default: work survives. */
  removeWorktree?: boolean;
}

/**
 * Stop a session.
 *
 * The window is killed only when no other live session is still using the
 * branch: one window holds every session on a branch, so killing it because
 * *one* of them stopped would take the others down with it. The row is moved to
 * `stopped` either way — that is intent, and intent is what SQLite is the
 * authority over (ADR-08).
 */
export async function stopAgentSession(
  deps: Pick<AgentSessionDeps, 'tmux' | 'projectId' | 'storage' | 'worktrees' | 'now'>,
  session: AgentSession,
  options: StopAgentSessionOptions = {},
): Promise<AgentSession> {
  const now = deps.now ?? ((): Date => new Date());
  const stopped = await updateSessionStatus(deps.storage, session, 'stopped', now);

  const siblings = (await listSessions(deps.storage, { branch: session.branch })).filter(
    (other) => other.id !== session.id && isLiveSession(other),
  );
  if (siblings.length === 0) {
    try {
      await deps.tmux.killWindow(
        buildProjectSessionName(deps.projectId),
        buildWorktreeWindowName(session.branch),
      );
    } catch {
      // A window that is already gone is the state this call wanted. tmux
      // being unreachable is not a reason to leave the row saying `running`.
    }
    if (options.removeWorktree === true) {
      await deps.worktrees.remove(session.branch, { force: true });
    }
  }

  return stopped;
}
