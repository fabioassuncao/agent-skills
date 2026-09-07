import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isValidBranchName, slugify } from '../../conventions/git/slug.js';
import type { PaneTemplate } from '../../runtime/profiles.js';
import { interruptPrompt, sendPrompt } from '../../runtime/terminal/input.js';
import type { TmuxGateway } from '../../runtime/tmux/gateway.js';
import {
  type EnsureSessionLayoutResult,
  ensureSessionLayout,
  isWorktreeOpen,
  type PaneCommandSet,
  planSessionLayout,
} from '../../runtime/tmux/layout.js';
import {
  buildPaneTarget,
  buildProjectSessionName,
  buildWorktreeParkingWindowName,
  buildWorktreeWindowName,
} from '../../runtime/tmux/names.js';
import type { GitWorktreeGateway } from '../../runtime/worktree/git.js';
import type { CreatedWorktree, ManagedWorktree } from '../../runtime/worktree/lifecycle.js';
import { withWorktreeBranchLock } from '../../runtime/worktree/lock.js';
import type { WorktreeRuntimeKind } from '../../runtime/worktree/meta.js';
import { getWorktreeStoragePaths } from '../../runtime/worktree/paths.js';
import type { WorktreeSource } from '../../runtime/worktree/progress.js';
import {
  loadWorktree as loadStoredWorktree,
  type PlanRepositoryContext,
  restoreAgentSessionStates,
  saveAgentSessionActivation,
  saveWorktree as saveStoredWorktree,
  stopAgentSessionsForWorktree,
} from '../../storage/db/repository.js';
import { writeFileAtomic } from '../../utils/fs.js';
import {
  buildCustomAgentArgv,
  buildCustomAgentEnvironment,
  CUSTOM_AGENT_TEMPLATE_VARIABLES,
  type CustomAgentContext,
  type CustomAgentDefinition,
} from '../custom.js';
import {
  type AgentLaunchMode,
  buildDockerShellCommand,
  buildManagedShellCommand,
  buildPaneCommand,
  buildTtyAgentArgv,
  quoteShellArgument,
  SANDBOX_PATH_ENTRIES,
} from '../tty.js';
import { type AgentPermission, type AgentPhase, isAgentProviderId } from '../types.js';
import { canReuseSession, selectReusableSession } from './reuse.js';
import { createAgentSession, listSessions, saveSession, updateSessionStatus } from './store.js';
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
    baseBranch?: string;
    agent: string;
    profile?: string;
    /** `docker` when the profile runs the panes inside a container. */
    runtime?: WorktreeRuntimeKind;
    /** Values every pane and hook of the worktree exports. */
    startupEnvValues?: Record<string, string>;
    /** Ports this worktree owns, allocated before the checkout exists. */
    allocatedPorts?: Record<string, number>;
    source?: WorktreeSource;
  }): Promise<CreatedWorktree>;
  list(): Promise<ManagedWorktree[]>;
  remove(branch: string, options?: { force?: boolean; keepBranch?: boolean }): Promise<void>;
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
  /** Instructions contributed by the resolved runtime profile. */
  systemPrompt?: string;
  /** Durable per-branch mutation locks shared with independent CLI processes. */
  worktreeLockDir?: string;
  /**
   * Container every pane of the window runs inside. Absent → the host.
   *
   * It is the whole of the difference between the `interactive` and the
   * `sandbox` runtime here: the pane's *shell* becomes a `docker exec`, so the
   * agent command typed into it lands in the container without ever naming
   * docker itself (`agents/tty.ts`).
   */
  container?: string;
  /**
   * Login shell the shell panes run. Defaults to `$SHELL`.
   *
   * Only the *path* is configurable: the command around it is built per
   * worktree, because it sources that worktree's runtime env — a shell pane
   * that did not would show none of the ports the agent beside it is using.
   */
  shellPath?: string;
  /** Structured provider allocation used before a fresh TUI starts. */
  prepareConversation?: (
    provider: string,
    cwd: string,
    developerInstructions?: string,
  ) => Promise<string | null>;
  now?: () => Date;
}

export interface OpenAgentSessionInput {
  provider: string;
  /** Required when `provider` names a custom agent. */
  customAgent?: CustomAgentDefinition;
  permission: AgentPermission;
  /** Branch to work on. Generated when absent — that is what makes it *free*. */
  branch?: string;
  /** Explicit creation semantics used by the worktree dialog. */
  mode?: 'new' | 'existing';
  baseBranch?: string;
  startupEnvValues?: Record<string, string>;
  /** Service ports chosen by the session coordinator. Creation only. */
  allocatedPorts?: Record<string, number>;
  source?: WorktreeSource;
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
  /** Internal deterministic resume target (profile/open orchestration). */
  preferredSessionId?: string;
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
  /** Whether this call also created the local branch and owns deleting it on rollback. */
  branchCreated: boolean;
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
  input: {
    phase: AgentPhase | null;
    branch: string;
    provider: string;
    resumeWithoutConversation: boolean;
    preferredSessionId?: string;
  },
): { adopted: AgentSession | null; blockedBy: AgentSession | null } {
  const candidates = candidateSessions(
    sessions.filter((session) => session.provider === input.provider),
    input.phase,
  );
  const live = candidates.filter(isLiveSession);
  const preferred =
    input.preferredSessionId === undefined
      ? null
      : (candidates.find((session) => session.id === input.preferredSessionId) ?? null);
  // A deliberately closed window may still carry a provider conversation id.
  // Reopening continues that conversation; the independence gate remains in
  // selectReusableSession, so review/pr-review still always start fresh.
  const resumable = selectReusableSession({ ...input, sessions: candidates });
  const commandResumable =
    input.resumeWithoutConversation && canReuseSession(input.phase)
      ? ([...candidates]
          .filter((session) => session.status !== 'orphaned')
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null)
      : null;
  const adopted =
    (preferred !== null &&
    canReuseSession(input.phase) &&
    (preferred.conversationId !== null ||
      input.resumeWithoutConversation ||
      isLiveSession(preferred))
      ? preferred
      : null) ??
    resumable ??
    commandResumable ??
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

/**
 * What every pane of the window opens with, and what is typed into the agent's.
 *
 * The container case is the upstream's, verbatim in structure: the *shell* is
 * what enters the container, and the agent command is typed into a shell that
 * is already inside it — so the agent command never mentions docker (WebMux
 * `agent-service.ts` asserts exactly that, and so does `tty.test.ts`). What it
 * does carry is the `PATH` fallback, because `docker exec … /bin/sh -c` reads no
 * login profile.
 */
function buildPaneCommands(
  deps: AgentSessionDeps,
  argv: readonly string[],
  worktree: EnsuredSessionWorktree,
  customEnvironmentPath?: string,
): PaneCommandSet {
  const custom =
    customEnvironmentPath === undefined
      ? {}
      : {
          environmentFilePath: customEnvironmentPath,
          expandEnvironmentRefs: Object.values(CUSTOM_AGENT_TEMPLATE_VARIABLES),
        };
  if (deps.container === undefined) {
    return {
      agent: buildPaneCommand({ argv, runtimeEnvPath: worktree.runtimeEnvPath, ...custom }),
      shell: buildManagedShellCommand(worktree.runtimeEnvPath, deps.shellPath),
    };
  }
  return {
    agent: buildPaneCommand({
      argv,
      runtimeEnvPath: worktree.runtimeEnvPath,
      extraPathEntries: SANDBOX_PATH_ENTRIES,
      ...custom,
    }),
    // Never `deps.shellPath`: that is the *host's* login shell, and the image
    // has no reason to carry it. `buildDockerShellCommand` defaults to
    // `/bin/bash` and falls back to `/bin/sh`.
    shell: buildDockerShellCommand(deps.container, worktree.path, worktree.runtimeEnvPath),
  };
}

async function writeCustomAgentEnvironment(
  runtimeEnvPath: string,
  context: CustomAgentContext,
): Promise<string> {
  const path = join(dirname(runtimeEnvPath), `agent-${randomUUID()}.env`);
  const content = Object.entries(buildCustomAgentEnvironment(context))
    .map(([key, value]) => `export ${key}=${quoteShellArgument(value)}`)
    .join('\n');
  await writeFileAtomic(path, `${content}\n`);
  return path;
}

/** The pane the agent itself runs in — not necessarily the focused one. */
function agentPaneIndex(panes: readonly { kind: string; index: number }[]): number {
  return panes.find((pane) => pane.kind === 'agent')?.index ?? 0;
}

/** What a caller may decide about a worktree that does not exist yet. */
export interface EnsureSessionWorktreeInput {
  branch: string;
  /** Provider recorded on the binding, so a reopened worktree knows who used it. */
  agent: string;
  mode?: 'new' | 'existing';
  baseBranch?: string;
  /** `docker` when the panes will run inside a container. Creation only. */
  runtime?: WorktreeRuntimeKind;
  /** Ports the worktree owns. Creation only — a reused worktree keeps its own. */
  allocatedPorts?: Record<string, number>;
  /** Values every pane and hook exports. Creation only, for the same reason. */
  startupEnvValues?: Record<string, string>;
  source?: WorktreeSource;
}

export interface EnsuredSessionWorktree {
  path: string;
  worktreeId: string | null;
  runtimeEnvPath: string;
  /** Whether this call created it. What a teardown may remove depends on it. */
  created: boolean;
  branchCreated: boolean;
  /** The ports it actually owns: the allocated ones, or the ones it already had. */
  allocatedPorts: Record<string, number>;
}

/**
 * Find the worktree for a branch, or make one.
 *
 * `existing` when git already knows the branch, `new` otherwise: the worktree
 * manager refuses the wrong mode with a 409 rather than guessing, so the mode
 * is decided here, from the one question that answers it.
 *
 * Exported because the `interactive` and `sandbox` runtimes need exactly this
 * in `prepare()`, before there is any agent to open. A second copy of the
 * decision — which mode, which paths, whether it was created — is how a runtime
 * and a session start disagreeing about a worktree they both point at (§25).
 */
export async function ensureSessionWorktree(
  deps: AgentSessionDeps,
  input: EnsureSessionWorktreeInput,
): Promise<EnsuredSessionWorktree> {
  const existing = (await deps.worktrees.list()).find(
    (worktree) => worktree.branch === input.branch && worktree.entry !== null,
  );
  if (existing !== undefined) {
    if (input.mode === 'new') {
      throw new AgentSessionError(`Worktree already exists: ${input.branch}`, 409);
    }
    const gitDir = await deps.git.resolveWorktreeGitDir(existing.path);
    const currentBinding =
      existing.binding ?? (await loadStoredWorktree(deps.storage, input.branch));
    return {
      path: existing.path,
      // Branch names are reusable. Only the current durable binding can name
      // this checkout incarnation; a historical session row never can.
      worktreeId: currentBinding?.worktreeId ?? null,
      runtimeEnvPath: getWorktreeStoragePaths(gitDir).runtimeEnvPath,
      created: false,
      branchCreated: false,
      // What it already owns, never what the caller would have allocated: the
      // ports are in its `runtime.env` and in whatever is already listening on
      // them, and re-allocating on reuse would move a running service's port.
      allocatedPorts: currentBinding?.allocatedPorts ?? {},
    };
  }

  const allocatedPorts = input.allocatedPorts ?? {};
  const created = await deps.worktrees.create({
    branch: input.branch,
    mode: input.mode ?? ((await deps.branchExists(input.branch)) ? 'existing' : 'new'),
    ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
    agent: input.agent,
    profile: deps.profileName,
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    ...(input.startupEnvValues === undefined ? {} : { startupEnvValues: input.startupEnvValues }),
    ...(Object.keys(allocatedPorts).length === 0 ? {} : { allocatedPorts }),
    ...(input.source === undefined ? {} : { source: input.source }),
  });
  // git's view of the path, not the one that was built: on macOS `/var` is a
  // symlink to `/private/var`, so the two spell the same directory differently.
  // Every later call resolves the worktree through `list()`, so answering with
  // the constructed path here would hand a container a mount at one spelling
  // and its pane a `cd` to the other — which docker answers by creating an
  // empty directory instead of failing.
  const listed = (await deps.worktrees.list()).find(
    (worktree) => worktree.branch === input.branch && worktree.entry !== null,
  );
  return {
    path: listed?.path ?? created.path,
    worktreeId: created.worktreeId,
    runtimeEnvPath: created.runtimeEnvPath,
    created: true,
    branchCreated: created.branchCreated === true,
    allocatedPorts: created.meta.allocatedPorts,
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

  return withWorktreeBranchLock(
    deps.projectId,
    branch,
    async () => {
      const phase = input.phase ?? null;
      const worktree = await ensureSessionWorktree(deps, {
        branch,
        agent: input.provider,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
        ...(input.startupEnvValues === undefined
          ? {}
          : { startupEnvValues: input.startupEnvValues }),
        ...(input.allocatedPorts === undefined ? {} : { allocatedPorts: input.allocatedPorts }),
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(deps.container === undefined ? {} : { runtime: 'docker' as const }),
      });

      let layoutStarted = false;
      let completedLayout: EnsureSessionLayoutResult | null = null;
      let failureEvidence: AgentSession | null = null;
      let resolvedPaneTarget: string | null = null;
      let resolvedPaneToken: string | null = null;
      let customEnvironmentPath: string | undefined;
      try {
        const binding = await loadStoredWorktree(deps.storage, branch);
        const known =
          worktree.worktreeId === null
            ? []
            : (await listSessions(deps.storage, { branch })).filter(
                (session) => session.worktreeId === worktree.worktreeId,
              );
        let { adopted, blockedBy } = decideAdoption(known, {
          phase,
          branch,
          provider: input.provider,
          resumeWithoutConversation: input.customAgent?.resumeCommand !== undefined,
          ...(input.preferredSessionId === undefined && binding?.activeAgentSessionId == null
            ? {}
            : {
                preferredSessionId:
                  input.preferredSessionId ?? (binding?.activeAgentSessionId as string),
              }),
        });
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
          adopted !== null &&
          (adopted.conversationId !== null || input.customAgent?.resumeCommand !== undefined)
            ? 'resume'
            : 'fresh';
        const systemPrompt = input.systemPrompt ?? deps.systemPrompt;
        const preparedConversationId =
          adopted?.conversationId ??
          (launchMode === 'fresh' && deps.prepareConversation !== undefined
            ? await deps.prepareConversation(input.provider, worktree.path, systemPrompt)
            : null);
        const permission = adopted?.permission ?? input.permission;
        const now = deps.now ?? ((): Date => new Date());
        failureEvidence =
          adopted ??
          createAgentSession({
            branch,
            provider: input.provider,
            permission,
            worktreeId: worktree.worktreeId,
            paneTarget: null,
            paneToken: null,
            conversationId: preparedConversationId,
            status: 'starting',
            now,
            ...(input.label === undefined ? {} : { label: input.label }),
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            ...(phase === null ? {} : { phase }),
            ...(input.storyId === undefined ? {} : { storyId: input.storyId }),
          });

        const argv =
          input.customAgent === undefined
            ? (() => {
                if (!isAgentProviderId(input.provider)) {
                  throw new AgentSessionError(`Unknown agent '${input.provider}'.`, 400);
                }
                return buildTtyAgentArgv({
                  provider: input.provider,
                  permission,
                  launchMode:
                    launchMode === 'fresh' &&
                    input.provider === 'codex' &&
                    preparedConversationId !== null
                      ? 'resume'
                      : launchMode,
                  ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
                  ...(systemPrompt === undefined ? {} : { systemPrompt }),
                  ...(input.model === undefined || input.model === null
                    ? {}
                    : { model: input.model }),
                  ...(launchMode === 'resume' && adopted?.conversationId
                    ? { resumeConversationId: adopted.conversationId }
                    : {}),
                  ...(launchMode === 'fresh' &&
                  input.provider === 'codex' &&
                  preparedConversationId !== null
                    ? { resumeConversationId: preparedConversationId }
                    : {}),
                  ...(launchMode === 'fresh' &&
                  input.provider === 'claude' &&
                  preparedConversationId !== null
                    ? { pinConversationId: preparedConversationId }
                    : {}),
                });
              })()
            : buildCustomAgentArgv({
                definition: input.customAgent,
                launchMode,
              });
        if (input.customAgent !== undefined) {
          customEnvironmentPath = await writeCustomAgentEnvironment(worktree.runtimeEnvPath, {
            prompt: input.prompt,
            systemPrompt,
            worktreePath: worktree.path,
            repoRoot: deps.projectRoot,
            branch,
            profileName: deps.profileName,
            permission,
          });
        }

        const plan = planSessionLayout({
          projectId: deps.projectId,
          branch,
          templates: [...deps.panes],
          context: {
            repoRoot: deps.projectRoot,
            worktreePath: worktree.path,
            paneCommands: buildPaneCommands(deps, argv, worktree, customEnvironmentPath),
          },
        });

        layoutStarted = true;
        const layout = await ensureSessionLayout(deps.tmux, plan);
        completedLayout = layout;
        if (layout.mode === 'reattach' && customEnvironmentPath !== undefined) {
          await unlink(customEnvironmentPath).catch(() => {});
          customEnvironmentPath = undefined;
        }
        const paneCoordinate = buildPaneTarget(
          plan.sessionName,
          plan.windowName,
          agentPaneIndex(plan.panes),
        );
        const paneTarget = await deps.tmux.getPaneId(paneCoordinate);
        resolvedPaneTarget = paneTarget;
        let paneToken =
          layout.mode === 'reattach' ? (adopted?.paneToken ?? randomUUID()) : randomUUID();
        resolvedPaneToken = paneToken;
        if (deps.tmux.getPaneIdentity === undefined || deps.tmux.tagPaneOwner === undefined) {
          throw new AgentSessionError('The tmux gateway cannot prove pane ownership.', 501);
        }
        // A fresh/resumed layout just created this pane through an owner-scoped
        // coordinate, so tag it before reading identity. In a grouped session
        // tmux may otherwise report a viewer alias as `#{session_name}`. A
        // reattach must do the inverse: prove the old durable tag before touch.
        if (layout.mode !== 'reattach') {
          await deps.tmux.tagPaneOwner(paneTarget, paneToken, plan.sessionName);
        }
        const paneIdentity = await deps.tmux.getPaneIdentity(paneTarget);
        const legacyProof =
          layout.mode === 'reattach' &&
          adopted?.paneTarget?.startsWith('%') === false &&
          paneIdentity.ownerToken === null;
        if (
          (paneIdentity.sessionName !== plan.sessionName && !legacyProof) ||
          paneIdentity.windowName !== plan.windowName
        ) {
          throw new AgentSessionError('The agent pane belongs to another tmux owner.', 409);
        }
        if (layout.mode === 'reattach') {
          const physical = known.find(
            (candidate) =>
              candidate.paneToken !== null && candidate.paneToken === paneIdentity.ownerToken,
          );
          if (physical !== undefined) {
            adopted = physical;
            failureEvidence = physical;
            paneToken = physical.paneToken as string;
            resolvedPaneToken = paneToken;
          }
          if (adopted === null || (paneIdentity.ownerToken !== paneToken && !legacyProof)) {
            throw new AgentSessionError(
              'The live pane no longer belongs to this AgentSession.',
              409,
            );
          }
        }
        if (paneIdentity.ownerToken !== paneToken) {
          await deps.tmux.tagPaneOwner(paneTarget, paneToken, plan.sessionName);
        }

        // `reattach` means the window — and the agent inside it — was left running,
        // so the argv above was never executed and the prompt it carried never
        // arrived. Delivering it as a paste is the only way in, and it is exactly
        // what a subsequent turn already does.
        if (layout.mode === 'reattach' && input.prompt !== undefined && input.prompt !== '') {
          await sendPrompt(deps.tmux, paneTarget, input.prompt);
        }

        const persistAttachedSession = async (attached: AgentSession): Promise<void> => {
          failureEvidence = attached;
          if (binding === null) {
            await saveSession(deps.storage, attached);
          } else {
            await saveAgentSessionActivation(deps.storage, attached, {
              ...binding,
              activeAgentSessionId: attached.id,
              updatedAt: attached.updatedAt,
            });
          }
        };
        if (adopted !== null) {
          // The same conversation, continued for the same purpose: the binding it
          // already has is the binding, and minting a second row for it would split
          // one session's history in two.
          const session = {
            ...(adopted.status === 'stopped'
              ? { ...adopted, status: 'starting' as const, endedAt: null }
              : adopted),
            paneTarget,
            paneToken,
            updatedAt: now().toISOString(),
          };
          await persistAttachedSession(session);
          return {
            session,
            branch,
            worktreePath: worktree.path,
            paneTarget: session.paneTarget as string,
            layout,
            launchMode,
            worktreeCreated: worktree.created,
            branchCreated: worktree.branchCreated,
          };
        }

        const session = {
          ...(failureEvidence as AgentSession),
          paneTarget,
          paneToken,
          updatedAt: now().toISOString(),
        };
        await persistAttachedSession(session);

        return {
          session,
          branch,
          worktreePath: worktree.path,
          paneTarget,
          layout,
          launchMode,
          worktreeCreated: worktree.created,
          branchCreated: worktree.branchCreated,
        };
      } catch (error) {
        if (customEnvironmentPath !== undefined) {
          await unlink(customEnvironmentPath).catch(() => {});
        }
        const cleanupErrors: string[] = [];
        let physicalCleanupSafe = true;
        const sessionName = buildProjectSessionName(deps.projectId);
        const windowName = buildWorktreeWindowName(branch);
        const startedNewLayout = completedLayout !== null && completedLayout.mode !== 'reattach';
        if (startedNewLayout) {
          try {
            if (
              resolvedPaneTarget === null ||
              resolvedPaneToken === null ||
              deps.tmux.getPaneIdentity === undefined ||
              deps.tmux.killPaneStrict === undefined ||
              deps.tmux.killWindowStrict === undefined
            ) {
              throw new Error('the newly launched pane cannot be authenticated');
            }
            const identity = await deps.tmux.getPaneIdentity(resolvedPaneTarget);
            if (
              identity.paneId !== resolvedPaneTarget ||
              identity.sessionName !== sessionName ||
              identity.windowName !== windowName ||
              identity.ownerToken !== resolvedPaneToken
            ) {
              throw new Error('pane ownership changed; the unproven process was preserved');
            }
            await deps.tmux.killPaneStrict(identity.paneId);
            // The remaining panes are services/shells created by this same
            // failed layout. Remove them only after the writer's full owner
            // tuple was proved and its strict kill completed.
            await deps.tmux.killWindowStrict(sessionName, windowName);
          } catch (cleanupError) {
            physicalCleanupSafe = false;
            cleanupErrors.push(
              `tmux cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            );
          }
        } else if (worktree.created && completedLayout?.mode === 'reattach') {
          // The checkout is new, but the tmux window is not: it predates this
          // call and may contain a writer from a prior branch incarnation.
          // A post-reattach failure is never authority to kill that process or
          // remove the checkout underneath it.
          physicalCleanupSafe = false;
          cleanupErrors.push('stale reattached window was preserved');
        } else if (worktree.created && layoutStarted && completedLayout === null) {
          // Compatibility for failures inside layout construction. The whole
          // checkout was created by this operation, so its exact project/window
          // target is the only process scope the rollback may touch.
          try {
            if (deps.tmux.killWindowStrict === undefined) {
              throw new Error('strict tmux window cleanup is unavailable');
            }
            await deps.tmux.killWindowStrict(sessionName, windowName);
          } catch (cleanupError) {
            physicalCleanupSafe = false;
            cleanupErrors.push(
              `tmux cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            );
          }
        }
        if (worktree.created && physicalCleanupSafe) {
          try {
            await deps.worktrees.remove(branch, { keepBranch: !worktree.branchCreated });
          } catch (cleanupError) {
            cleanupErrors.push(
              `worktree cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            );
          }
        }
        if (!physicalCleanupSafe && failureEvidence !== null) {
          const evidenceAt = (deps.now ?? ((): Date => new Date()))().toISOString();
          try {
            await saveSession(deps.storage, {
              ...failureEvidence,
              paneTarget: resolvedPaneTarget,
              paneToken: resolvedPaneToken,
              status: 'orphaned',
              updatedAt: evidenceAt,
              endedAt: null,
            });
            cleanupErrors.push('orphan evidence persisted');
          } catch (evidenceError) {
            cleanupErrors.push(
              `orphan evidence persistence failed: ${evidenceError instanceof Error ? evidenceError.message : String(evidenceError)}`,
            );
          }
        }
        if (cleanupErrors.length === 0) throw error;
        const original = error instanceof Error ? error.message : String(error);
        const status =
          worktree.created && completedLayout?.mode === 'reattach'
            ? 409
            : error instanceof AgentSessionError
              ? error.status
              : 500;
        throw new AgentSessionError(`${original}; ${cleanupErrors.join('; ')}`, status);
      }
    },
    { lockDir: deps.worktreeLockDir },
  );
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
  options: { preamble?: string } = {},
): Promise<void> {
  await sendPrompt(deps.tmux, requirePane(session), text, options);
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
  deps: Pick<
    AgentSessionDeps,
    'tmux' | 'projectId' | 'storage' | 'worktrees' | 'worktreeLockDir' | 'now'
  >,
  session: AgentSession,
  options: StopAgentSessionOptions = {},
): Promise<AgentSession> {
  const stop = async (): Promise<AgentSession> => {
    const now = deps.now ?? ((): Date => new Date());
    const current =
      (await listSessions(deps.storage, { branch: session.branch })).find(
        (candidate) => candidate.id === session.id,
      ) ?? session;
    const binding = await loadStoredWorktree(deps.storage, current.branch);
    if (binding === null || current.worktreeId !== binding.worktreeId) {
      throw new AgentSessionError(`Session ${current.id} is not in the current worktree.`, 409);
    }
    const siblings = (await listSessions(deps.storage, { branch: current.branch })).filter(
      (other) =>
        other.id !== current.id && other.worktreeId === current.worktreeId && isLiveSession(other),
    );
    if (
      deps.tmux.hasPaneStrict === undefined ||
      deps.tmux.getPaneIdentity === undefined ||
      deps.tmux.tagPaneOwner === undefined ||
      deps.tmux.killPaneStrict === undefined ||
      deps.tmux.killWindowStrict === undefined ||
      deps.tmux.swapPanes === undefined ||
      deps.tmux.movePaneToWindow === undefined
    ) {
      throw new AgentSessionError('The tmux gateway cannot prove pane ownership.', 501);
    }
    const hasPaneStrict = deps.tmux.hasPaneStrict.bind(deps.tmux);
    const getPaneIdentity = deps.tmux.getPaneIdentity.bind(deps.tmux);
    const tagPaneOwner = deps.tmux.tagPaneOwner.bind(deps.tmux);
    const killPaneStrict = deps.tmux.killPaneStrict.bind(deps.tmux);
    const killWindowStrict = deps.tmux.killWindowStrict.bind(deps.tmux);
    const swapPanes = deps.tmux.swapPanes.bind(deps.tmux);
    const movePaneToWindow = deps.tmux.movePaneToWindow.bind(deps.tmux);

    const sessionName = buildProjectSessionName(deps.projectId);
    const mainWindow = buildWorktreeWindowName(current.branch);
    const parkingWindow = buildWorktreeParkingWindowName(binding.worktreeId);
    const authenticate = async (candidate: AgentSession) => {
      if (candidate.paneTarget === null || !(await hasPaneStrict(candidate.paneTarget))) {
        return { session: candidate, identity: null };
      }
      const identity = await getPaneIdentity(candidate.paneTarget);
      if (
        identity.sessionName !== sessionName ||
        (identity.windowName !== mainWindow && identity.windowName !== parkingWindow)
      ) {
        return { session: candidate, identity: null };
      }
      if (candidate.paneToken !== null && identity.ownerToken === candidate.paneToken) {
        return { session: candidate, identity };
      }
      if (!candidate.paneTarget.startsWith('%') && identity.ownerToken === null) {
        const paneToken = randomUUID();
        await tagPaneOwner(identity.paneId, paneToken, sessionName);
        const upgraded = { ...candidate, paneTarget: identity.paneId, paneToken };
        await saveSession(deps.storage, upgraded);
        return { session: upgraded, identity: { ...identity, ownerToken: paneToken } };
      }
      return { session: candidate, identity: null };
    };

    const target = await authenticate(current);
    if (
      current.paneTarget !== null &&
      target.identity === null &&
      (await hasPaneStrict(current.paneTarget))
    ) {
      throw new AgentSessionError(`Pane ownership changed for session ${current.id}.`, 409);
    }

    if (options.removeWorktree === true) {
      const snapshot = [target.session, ...siblings];
      const proveNotForeign = async (candidate: AgentSession): Promise<void> => {
        if (candidate.paneTarget === null || !(await hasPaneStrict(candidate.paneTarget))) return;
        if ((await authenticate(candidate)).identity === null) {
          throw new AgentSessionError(`Pane ownership changed for session ${candidate.id}.`, 409);
        }
      };
      for (const candidate of snapshot) await proveNotForeign(candidate);
      const stoppedAt = now().toISOString();
      await stopAgentSessionsForWorktree(deps.storage, binding.worktreeId, stoppedAt);
      try {
        // Revalidate after durable intent and before the broad physical kill.
        // The branch lock excludes Issue Flow races; this second proof covers
        // an external tmux restart or pane replacement at the boundary.
        for (const candidate of snapshot) await proveNotForeign(candidate);
        await killWindowStrict(sessionName, mainWindow);
        await killWindowStrict(sessionName, parkingWindow);
      } catch (error) {
        try {
          await restoreAgentSessionStates(deps.storage, snapshot);
        } catch (rollbackError) {
          throw new AgentSessionError(
            `${error instanceof Error ? error.message : String(error)}; bulk stop-intent rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            500,
          );
        }
        throw error;
      }
      await deps.worktrees.remove(current.branch, { force: true });
      return {
        ...target.session,
        status: 'stopped',
        updatedAt: stoppedAt,
        endedAt: stoppedAt,
      };
    }

    if (binding.activeAgentSessionId === current.id && siblings.length > 0) {
      const authenticatedSiblings: Array<Awaited<ReturnType<typeof authenticate>>> = [];
      for (const candidate of siblings) {
        const authenticated = await authenticate(candidate);
        if (authenticated.identity !== null) authenticatedSiblings.push(authenticated);
      }
      const successor =
        authenticatedSiblings.sort((left, right) => {
          const visible =
            Number(right.identity?.windowName === mainWindow) -
            Number(left.identity?.windowName === mainWindow);
          if (visible !== 0) return visible;
          const root =
            Number(right.session.parentSessionId === null) -
            Number(left.session.parentSessionId === null);
          return root !== 0 ? root : left.session.createdAt.localeCompare(right.session.createdAt);
        })[0] ?? null;
      if (successor === null) {
        throw new AgentSessionError('No authenticated sibling can become the active tab.', 409);
      }
      const successorIdentity = successor.identity;
      if (successorIdentity === null) {
        throw new AgentSessionError('No authenticated sibling can become the active tab.', 409);
      }
      let layoutChange: 'swap' | 'move' | null = null;
      if (successorIdentity.windowName !== mainWindow) {
        if (target.identity?.windowName === mainWindow) {
          await swapPanes(successorIdentity.paneId, target.identity.paneId);
          layoutChange = 'swap';
        } else {
          await movePaneToWindow(successorIdentity.paneId, `${sessionName}:${mainWindow}`);
          layoutChange = 'move';
        }
      }
      try {
        await saveStoredWorktree(deps.storage, {
          ...binding,
          activeAgentSessionId: successor.session.id,
          updatedAt: now().toISOString(),
        });
      } catch (error) {
        try {
          const successorStillOwned = await authenticate(successor.session);
          const targetStillOwned = await authenticate(target.session);
          if (successorStillOwned.identity === null) {
            throw new Error('successor pane ownership changed');
          }
          if (layoutChange === 'swap') {
            if (targetStillOwned.identity === null) {
              throw new Error('target pane ownership changed');
            }
            await swapPanes(successorStillOwned.identity.paneId, targetStillOwned.identity.paneId);
          } else if (layoutChange === 'move') {
            await movePaneToWindow(
              successorStillOwned.identity.paneId,
              `${sessionName}:${parkingWindow}`,
            );
          }
        } catch (rollbackError) {
          throw new AgentSessionError(
            `${error instanceof Error ? error.message : String(error)}; active-tab rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            500,
          );
        }
        throw error;
      }
    }

    const stopped = await updateSessionStatus(deps.storage, target.session, 'stopped', now);
    try {
      if (target.identity !== null) {
        const beforeKill = await authenticate(target.session);
        if (beforeKill.identity === null) {
          throw new AgentSessionError(`Pane ownership changed for session ${current.id}.`, 409);
        }
        await killPaneStrict(beforeKill.identity.paneId);
      } else if (
        target.session.paneTarget !== null &&
        (await hasPaneStrict(target.session.paneTarget))
      ) {
        // It was absent at preflight but appeared before teardown. Treat that
        // as a fresh ownership boundary, not permission to kill the window
        // around an unproven process.
        const appeared = await authenticate(target.session);
        if (appeared.identity === null) {
          throw new AgentSessionError(`Pane ownership changed for session ${current.id}.`, 409);
        }
        await killPaneStrict(appeared.identity.paneId);
      }
      if (siblings.length === 0) {
        await killWindowStrict(sessionName, mainWindow);
        await killWindowStrict(sessionName, parkingWindow);
      }
    } catch (error) {
      try {
        await saveSession(deps.storage, target.session);
      } catch (rollbackError) {
        throw new AgentSessionError(
          `${error instanceof Error ? error.message : String(error)}; stop-intent rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          500,
        );
      }
      throw error;
    }
    return stopped;
  };

  return withWorktreeBranchLock(deps.projectId, session.branch, stop, {
    lockDir: deps.worktreeLockDir,
  });
}
