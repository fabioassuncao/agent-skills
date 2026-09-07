import { randomUUID } from 'node:crypto';
import {
  ensureSessionLayout,
  planSessionLayout,
  type SessionLayoutMode,
} from '../../runtime/tmux/layout.js';
import {
  buildProjectSessionName,
  buildWorktreeParkingWindowName,
  buildWorktreeWindowName,
} from '../../runtime/tmux/names.js';
import { withWorktreeBranchLock } from '../../runtime/worktree/lock.js';
import { getWorktreeStoragePaths } from '../../runtime/worktree/paths.js';
import type { StoredWorktree } from '../../storage/db/repository.js';
import { saveAgentTabCreation, saveWorktree } from '../../storage/db/repository.js';
import { buildManagedShellCommand, buildPaneCommand, buildTtyAgentArgv } from '../tty.js';
import { CodexAppServerClient } from './codex.js';
import type { ResolvedAgentSessionContext } from './context.js';
import { assertSessionReuseAllowed, SessionReuseError } from './reuse.js';
import { createAgentSession, listSessions, saveSession, updateSessionStatus } from './store.js';
import { type AgentSession, isLiveSession } from './types.js';

/** A wire tab is an AgentSession id; provider conversation identity is separate. */
export interface AgentSessionTab {
  tabId: string;
  kind: 'root' | 'fork';
  label: string;
  seq: number | null;
  sessionId: string;
  paneId?: string;
  createdAt: string;
}

export interface WorktreeTabsProjection {
  tabs: AgentSessionTab[];
  activeTabId: string | null;
  activeSession: AgentSession | null;
  rootSession: AgentSession | null;
}

export class AgentTabError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AgentTabError';
  }
}

export interface AgentTabOptions {
  /** Structured provider seam. Never discover a conversation by scanning cwd. */
  forkCodex?: (conversationId: string) => Promise<string>;
  now?: () => Date;
}

function nowOf(context: ResolvedAgentSessionContext, options: AgentTabOptions): Date {
  return (options.now ?? context.deps.now ?? (() => new Date()))();
}

function rootFor(
  sessions: readonly AgentSession[],
  binding: StoredWorktree | null,
): AgentSession | null {
  const active = sessions.find((session) => session.id === binding?.activeAgentSessionId);
  if (active?.parentSessionId) {
    const parent = sessions.find((session) => session.id === active.parentSessionId);
    if (parent) return parent;
  }
  if (active && active.parentSessionId === null && active.tabSequence === 0) return active;
  const candidates = sessions
    .filter(
      (session) =>
        session.parentSessionId === null &&
        (session.tabSequence === 0 || session.tabSequence === null),
    )
    .sort((left, right) => {
      const live = Number(isLiveSession(right)) - Number(isLiveSession(left));
      if (live !== 0) return live;
      const updated = right.updatedAt.localeCompare(left.updatedAt);
      return updated !== 0 ? updated : right.id.localeCompare(left.id);
    });
  return candidates[0] ?? null;
}

export function projectAgentSessionTabs(
  sessions: readonly AgentSession[],
  binding: StoredWorktree | null,
): WorktreeTabsProjection {
  const root = rootFor(sessions, binding);
  if (root === null) {
    return { tabs: [], activeTabId: null, activeSession: null, rootSession: null };
  }
  const related = [
    root,
    ...sessions.filter(
      (session) => session.parentSessionId === root.id && session.status !== 'stopped',
    ),
  ].sort((left, right) => (left.tabSequence ?? 0) - (right.tabSequence ?? 0));
  const active = related.find((session) => session.id === binding?.activeAgentSessionId) ?? root;
  return {
    tabs: related.map((session) => ({
      tabId: session.id,
      kind: session.id === root.id ? 'root' : 'fork',
      label: session.id === root.id ? 'Root' : `Fork ${session.tabSequence ?? 0}`,
      seq: session.id === root.id ? null : session.tabSequence,
      sessionId: session.id,
      ...(session.paneTarget?.startsWith('%') ? { paneId: session.paneTarget } : {}),
      createdAt: session.createdAt,
    })),
    activeTabId: active.id,
    activeSession: active,
    rootSession: root,
  };
}

interface PreparedTabs {
  binding: StoredWorktree;
  path: string;
  runtimeEnvPath: string;
  sessions: AgentSession[];
  root: AgentSession;
  sessionName: string;
  windowName: string;
  parkingWindow: string;
}

function requireTabTmux(context: ResolvedAgentSessionContext) {
  const tmux = context.deps.tmux;
  if (
    tmux.hasWindowStrict === undefined ||
    tmux.hasPaneStrict === undefined ||
    tmux.getPaneWindow === undefined ||
    tmux.getPaneIdentity === undefined ||
    tmux.tagPaneOwner === undefined ||
    tmux.createParkedPane === undefined ||
    tmux.swapPanes === undefined ||
    tmux.movePaneToWindow === undefined ||
    tmux.killPaneStrict === undefined ||
    tmux.listPaneLocations === undefined
  ) {
    throw new AgentTabError('This tmux gateway does not support agent tabs.', 501);
  }
  return {
    ...tmux,
    hasWindowStrict: tmux.hasWindowStrict.bind(tmux),
    hasPaneStrict: tmux.hasPaneStrict.bind(tmux),
    getPaneWindow: tmux.getPaneWindow.bind(tmux),
    getPaneIdentity: tmux.getPaneIdentity.bind(tmux),
    tagPaneOwner: tmux.tagPaneOwner.bind(tmux),
    createParkedPane: tmux.createParkedPane.bind(tmux),
    swapPanes: tmux.swapPanes.bind(tmux),
    movePaneToWindow: tmux.movePaneToWindow.bind(tmux),
    killPaneStrict: tmux.killPaneStrict.bind(tmux),
    listPaneLocations: tmux.listPaneLocations.bind(tmux),
  };
}

function paneLocationAllowed(
  prepared: PreparedTabs,
  identity: { sessionName: string; windowName: string },
): boolean {
  return (
    identity.sessionName === prepared.sessionName &&
    (identity.windowName === prepared.windowName || identity.windowName === prepared.parkingWindow)
  );
}

async function ownedPaneIdentity(
  context: ResolvedAgentSessionContext,
  prepared: PreparedTabs,
  session: AgentSession,
) {
  if (session.paneTarget === null || session.paneToken === null) return null;
  const tmux = requireTabTmux(context);
  if (!(await tmux.hasPaneStrict(session.paneTarget))) return null;
  const identity = await tmux.getPaneIdentity(session.paneTarget);
  return paneLocationAllowed(prepared, identity) && identity.ownerToken === session.paneToken
    ? identity
    : null;
}

type PaneOwnership =
  | { kind: 'absent' }
  | { kind: 'foreign' }
  | { kind: 'owned'; identity: NonNullable<Awaited<ReturnType<typeof ownedPaneIdentity>>> };

async function inspectPaneOwnership(
  context: ResolvedAgentSessionContext,
  prepared: PreparedTabs,
  session: AgentSession,
): Promise<PaneOwnership> {
  if (session.paneTarget === null) return { kind: 'absent' };
  const tmux = requireTabTmux(context);
  if (!(await tmux.hasPaneStrict(session.paneTarget))) return { kind: 'absent' };
  if (session.paneToken === null) return { kind: 'foreign' };
  const identity = await tmux.getPaneIdentity(session.paneTarget);
  return paneLocationAllowed(prepared, identity) && identity.ownerToken === session.paneToken
    ? { kind: 'owned', identity }
    : { kind: 'foreign' };
}

async function killOwnedPane(
  context: ResolvedAgentSessionContext,
  prepared: PreparedTabs,
  session: AgentSession,
): Promise<boolean> {
  const identity = await ownedPaneIdentity(context, prepared, session);
  if (identity === null) return false;
  await requireTabTmux(context).killPaneStrict(identity.paneId);
  return true;
}

function assertForkable(provider: string): asserts provider is 'claude' | 'codex' {
  if (provider !== 'claude' && provider !== 'codex') {
    throw new AgentTabError(
      `Agent '${provider}' has no provider-native, safely resumable fork command.`,
      409,
    );
  }
}

async function stablePane(
  session: AgentSession,
  context: ResolvedAgentSessionContext,
  options: AgentTabOptions,
): Promise<AgentSession> {
  if (session.paneTarget === null) return session;
  const tmux = requireTabTmux(context);
  if (!(await tmux.hasPaneStrict(session.paneTarget))) return session;
  const identity = await tmux.getPaneIdentity(session.paneTarget);
  const sessionName = buildProjectSessionName(context.projectId);
  const windowName = buildWorktreeWindowName(session.branch);
  if (identity.sessionName !== sessionName || identity.windowName !== windowName) return session;
  if (session.paneTarget.startsWith('%')) {
    return session;
  }
  const paneToken = session.paneToken ?? randomUUID();
  await tmux.tagPaneOwner(identity.paneId, paneToken, sessionName);
  const next = {
    ...session,
    paneTarget: identity.paneId,
    paneToken,
    updatedAt: nowOf(context, options).toISOString(),
  };
  await saveSession(context.storage, next);
  return next;
}

async function prepare(
  context: ResolvedAgentSessionContext,
  branch: string,
  options: AgentTabOptions,
): Promise<PreparedTabs> {
  const managed = (await context.worktrees.list()).find(
    (candidate) => candidate.branch === branch && candidate.entry !== null,
  );
  if (managed?.binding == null) throw new AgentTabError(`Worktree not found: ${branch}`, 404);
  if (managed.binding.runtime !== 'host') {
    throw new AgentTabError('Agent tabs are not available for sandbox worktrees yet.', 409);
  }
  if (managed.binding.profile !== context.profileName) {
    throw new AgentTabError(
      `Worktree profile changed from '${context.profileName}' to '${managed.binding.profile}'; retry the tab operation.`,
      409,
    );
  }
  let sessions = (await listSessions(context.storage, { branch })).filter(
    (session) => session.worktreeId === managed.binding?.worktreeId,
  );
  let binding = managed.binding;
  let projected = projectAgentSessionTabs(sessions, binding);
  if (projected.rootSession === null || projected.rootSession.tabSequence === null) {
    const candidate = [...sessions]
      .filter(
        (session) =>
          session.id === projected.rootSession?.id ||
          (session.parentSessionId === null && session.tabSequence === null),
      )
      .sort((left, right) => {
        const live = Number(isLiveSession(right)) - Number(isLiveSession(left));
        if (live !== 0) return live;
        const updated = right.updatedAt.localeCompare(left.updatedAt);
        return updated !== 0 ? updated : right.id.localeCompare(left.id);
      })[0];
    if (candidate !== undefined) {
      const root = {
        ...candidate,
        tabSequence: 0,
        updatedAt: nowOf(context, options).toISOString(),
      };
      await saveSession(context.storage, root);
      binding = await saveBinding(
        context,
        binding,
        { activeAgentSessionId: root.id, tabSequenceCounter: binding.tabSequenceCounter ?? 0 },
        options,
      );
      sessions = sessions.map((session) => (session.id === root.id ? root : session));
      projected = projectAgentSessionTabs(sessions, binding);
    }
  }
  if (projected.rootSession === null) {
    throw new AgentTabError(`Worktree ${branch} has no root AgentSession.`, 409);
  }
  const root = await stablePane(projected.rootSession, context, options);
  const gitDir = await context.git.resolveWorktreeGitDir(managed.path);
  return {
    binding,
    path: managed.path,
    runtimeEnvPath: getWorktreeStoragePaths(gitDir).runtimeEnvPath,
    sessions: sessions.map((session) => (session.id === root.id ? root : session)),
    root,
    sessionName: buildProjectSessionName(context.projectId),
    windowName: buildWorktreeWindowName(branch),
    parkingWindow: buildWorktreeParkingWindowName(binding.worktreeId),
  };
}

async function saveBinding(
  context: ResolvedAgentSessionContext,
  binding: StoredWorktree,
  patch: Pick<StoredWorktree, 'activeAgentSessionId' | 'tabSequenceCounter'>,
  options: AgentTabOptions,
): Promise<StoredWorktree> {
  const next = { ...binding, ...patch, updatedAt: nowOf(context, options).toISOString() };
  await saveWorktree(context.storage, next);
  return next;
}

async function forkCodexConversation(
  conversationId: string,
  options: AgentTabOptions,
): Promise<string> {
  if (options.forkCodex !== undefined) return await options.forkCodex(conversationId);
  const client = new CodexAppServerClient({ clientName: 'issue-flow-tabs' });
  try {
    return (await client.threadFork(conversationId)).thread.id;
  } finally {
    client.close();
  }
}

async function bringToFront(
  context: ResolvedAgentSessionContext,
  prepared: PreparedTabs,
  targetPane: string,
  _outgoing: AgentSession | null,
): Promise<() => Promise<void>> {
  const tmux = requireTabTmux(context);
  const targetSession = prepared.sessions.find((session) => session.paneTarget === targetPane);
  if (targetSession === undefined) {
    throw new AgentTabError(`Pane ${targetPane} is not bound to a tab in this worktree.`, 409);
  }
  const targetIdentity = await ownedPaneIdentity(context, prepared, targetSession);
  if (targetIdentity === null) {
    throw new AgentTabError(`Pane ownership changed for session ${targetSession.id}.`, 409);
  }
  const targetWindow = targetIdentity.windowName;
  if (targetWindow === prepared.windowName) {
    await tmux.selectPane(targetPane);
    return async () => {};
  }
  // The visible pane is physical truth. The binding can legitimately lag one
  // swap after a crash, and swapping against a merely "active" parked pane
  // would leave the actual visible agent untouched (or join beside services).
  const locations = new Map((await tmux.listPaneLocations()).map((entry) => [entry.paneId, entry]));
  const physicallyVisible = prepared.sessions.find((session) => {
    if (session.paneTarget?.startsWith('%') !== true) return false;
    const location = locations.get(session.paneTarget);
    return (
      location?.sessionName === prepared.sessionName &&
      location.windowName === prepared.windowName &&
      location.ownerToken === session.paneToken
    );
  });
  const outgoingPane = physicallyVisible?.paneTarget;
  if (
    outgoingPane !== null &&
    outgoingPane !== undefined &&
    outgoingPane !== targetPane &&
    (await tmux.hasPaneStrict(outgoingPane))
  ) {
    await tmux.swapPanes(targetPane, outgoingPane);
    try {
      await tmux.selectPane(targetPane);
    } catch (error) {
      try {
        if (
          physicallyVisible === undefined ||
          (await ownedPaneIdentity(context, prepared, targetSession)) === null ||
          (await ownedPaneIdentity(context, prepared, physicallyVisible)) === null
        ) {
          throw new Error('pane ownership changed during swap rollback');
        }
        await tmux.swapPanes(targetPane, outgoingPane);
      } catch (rollbackError) {
        throw new AgentTabError(
          `${error instanceof Error ? error.message : String(error)}; swap rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          500,
        );
      }
      throw error;
    }
    return async () => {
      if (
        physicallyVisible === undefined ||
        (await ownedPaneIdentity(context, prepared, targetSession)) === null ||
        (await ownedPaneIdentity(context, prepared, physicallyVisible)) === null
      ) {
        throw new Error('pane ownership changed during swap rollback');
      }
      await tmux.swapPanes(targetPane, outgoingPane);
    };
  }
  await tmux.movePaneToWindow(targetPane, `${prepared.sessionName}:${prepared.windowName}`);
  try {
    await tmux.selectPane(targetPane);
  } catch (error) {
    try {
      if ((await ownedPaneIdentity(context, prepared, targetSession)) === null) {
        throw new Error('pane ownership changed during move rollback');
      }
      await tmux.movePaneToWindow(targetPane, `${prepared.sessionName}:${targetWindow}`);
    } catch (rollbackError) {
      throw new AgentTabError(
        `${error instanceof Error ? error.message : String(error)}; move rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        500,
      );
    }
    throw error;
  }
  return async () => {
    if ((await ownedPaneIdentity(context, prepared, targetSession)) === null) {
      throw new Error('pane ownership changed during move rollback');
    }
    await tmux.movePaneToWindow(targetPane, `${prepared.sessionName}:${targetWindow}`);
  };
}

export async function createAgentTab(
  context: ResolvedAgentSessionContext,
  branch: string,
  options: AgentTabOptions = {},
): Promise<AgentSessionTab> {
  return await withWorktreeBranchLock(
    context.projectId,
    branch,
    async () => {
      const prepared = await prepare(context, branch, options);
      assertForkable(prepared.root.provider);
      try {
        assertSessionReuseAllowed(prepared.root.phase);
      } catch (error) {
        if (!(error instanceof SessionReuseError)) throw error;
        throw new AgentTabError(
          `Phase '${prepared.root.phase}' must remain independent and cannot be forked.`,
          409,
        );
      }
      if (prepared.root.conversationId === null) {
        throw new AgentTabError(
          `The ${prepared.root.provider} conversation id has not been recorded yet.`,
          409,
        );
      }
      const tmux = requireTabTmux(context);
      if ((await ownedPaneIdentity(context, prepared, prepared.root)) === null) {
        throw new AgentTabError(
          'The root session pane is not live; refresh it before forking.',
          409,
        );
      }
      const seq =
        Math.max(
          prepared.binding.tabSequenceCounter ?? 0,
          ...prepared.sessions.map((session) => session.tabSequence ?? 0),
        ) + 1;
      const conversationId =
        prepared.root.provider === 'claude'
          ? randomUUID()
          : await forkCodexConversation(prepared.root.conversationId, options);
      const argv = buildTtyAgentArgv({
        provider: prepared.root.provider,
        permission: prepared.root.permission,
        launchMode: prepared.root.provider === 'claude' ? 'fork' : 'resume',
        ...(prepared.root.provider === 'claude'
          ? {
              forkFromConversationId: prepared.root.conversationId,
              pinConversationId: conversationId,
            }
          : { resumeConversationId: conversationId }),
      });
      let paneId: string | null = null;
      let session: AgentSession = createAgentSession({
        branch,
        provider: prepared.root.provider,
        permission: prepared.root.permission,
        runId: prepared.root.runId,
        phase: prepared.root.phase,
        storyId: prepared.root.storyId,
        worktreeId: prepared.root.worktreeId,
        conversationId,
        paneTarget: null,
        parentSessionId: prepared.root.id,
        tabSequence: seq,
        label: `Fork ${seq}`,
        status: 'starting',
        now: () => nowOf(context, options),
      });
      let rollbackSwap: (() => Promise<void>) | null = null;
      try {
        paneId = await tmux.createParkedPane({
          sessionName: prepared.sessionName,
          parkingWindow: prepared.parkingWindow,
          cwd: prepared.path,
          command: buildManagedShellCommand(prepared.runtimeEnvPath, context.deps.shellPath),
        });
        session = { ...session, paneTarget: paneId };
        prepared.sessions = [...prepared.sessions, session];
        await tmux.tagPaneOwner(paneId, session.paneToken as string, prepared.sessionName);
        await tmux.runCommand(
          paneId,
          buildPaneCommand({ argv, runtimeEnvPath: prepared.runtimeEnvPath }),
        );
        const active =
          prepared.sessions.find(
            (candidate) => candidate.id === prepared.binding.activeAgentSessionId,
          ) ?? prepared.root;
        rollbackSwap = await bringToFront(context, prepared, paneId, active);
        await saveAgentTabCreation(context.storage, session, {
          ...prepared.binding,
          activeAgentSessionId: session.id,
          tabSequenceCounter: seq,
          updatedAt: nowOf(context, options).toISOString(),
        });
        return projectAgentSessionTabs(prepared.sessions, {
          ...prepared.binding,
          activeAgentSessionId: session.id,
          tabSequenceCounter: seq,
        }).tabs.at(-1) as AgentSessionTab;
      } catch (error) {
        let rollbackError: unknown = null;
        let killError: unknown = null;
        try {
          await rollbackSwap?.();
        } catch (caught) {
          rollbackError = caught;
        }
        try {
          if (paneId !== null && !(await killOwnedPane(context, prepared, session))) {
            throw new Error(`pane ownership changed for ${session.id}; foreign pane was preserved`);
          }
        } catch (caught) {
          killError = caught;
        }
        {
          const physicalActive =
            killError !== null &&
            paneId !== null &&
            (await ownedPaneIdentity(context, prepared, session).catch(() => null))?.windowName ===
              prepared.windowName
              ? session.id
              : (prepared.binding.activeAgentSessionId ?? prepared.root.id);
          const evidence: AgentSession = {
            ...session,
            status: killError === null ? 'stopped' : 'orphaned',
            endedAt: nowOf(context, options).toISOString(),
          };
          try {
            await saveAgentTabCreation(context.storage, evidence, {
              ...prepared.binding,
              activeAgentSessionId: physicalActive,
              tabSequenceCounter: seq,
              updatedAt: nowOf(context, options).toISOString(),
            });
          } catch (evidenceError) {
            const original = error instanceof Error ? error.message : String(error);
            throw new AgentTabError(
              `${original}; tab evidence persistence failed: ${evidenceError instanceof Error ? evidenceError.message : String(evidenceError)}`,
              500,
            );
          }
        }
        if (rollbackError !== null || killError !== null) {
          const original = error instanceof Error ? error.message : String(error);
          throw new AgentTabError(
            `${original}; rollback failed: ${[rollbackError, killError]
              .filter((value) => value !== null)
              .map((value) => (value instanceof Error ? value.message : String(value)))
              .join('; ')}`,
            500,
          );
        }
        throw error;
      }
    },
    { lockDir: context.deps.worktreeLockDir },
  );
}

async function selectAgentTabUnlocked(
  context: ResolvedAgentSessionContext,
  prepared: PreparedTabs,
  tabId: string,
  options: AgentTabOptions,
): Promise<void> {
  const projection = projectAgentSessionTabs(prepared.sessions, prepared.binding);
  const target = prepared.sessions.find((session) => session.id === tabId);
  if (target === undefined || !projection.tabs.some((tab) => tab.tabId === tabId)) {
    throw new AgentTabError(`Tab not found: ${tabId}`, 404);
  }
  const ensured = await ensureAgentTabPane(context, prepared, target, options);
  const liveTarget = ensured.session;
  prepared.sessions = prepared.sessions.map((session) =>
    session.id === liveTarget.id ? liveTarget : session,
  );
  const outgoing = projection.activeSession;
  if (outgoing?.id === liveTarget.id) {
    await bringToFront(context, prepared, liveTarget.paneTarget as string, null);
    return;
  }
  let rollbackLayout: (() => Promise<void>) | null = null;
  try {
    rollbackLayout = await bringToFront(
      context,
      prepared,
      liveTarget.paneTarget as string,
      outgoing,
    );
    prepared.binding = await saveBinding(
      context,
      prepared.binding,
      {
        activeAgentSessionId: liveTarget.id,
        tabSequenceCounter: prepared.binding.tabSequenceCounter ?? 0,
      },
      options,
    );
  } catch (error) {
    try {
      await rollbackLayout?.();
    } catch (rollbackError) {
      // The swap is still the physical truth. Persist it rather than claiming
      // the old tab is active while the new one occupies the visible slot.
      try {
        prepared.binding = await saveBinding(
          context,
          prepared.binding,
          {
            activeAgentSessionId: liveTarget.id,
            tabSequenceCounter: prepared.binding.tabSequenceCounter ?? 0,
          },
          options,
        );
      } catch (truthError) {
        throw new AgentTabError(
          `${error instanceof Error ? error.message : String(error)}; layout rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}; physical-state persistence failed: ${truthError instanceof Error ? truthError.message : String(truthError)}`,
          500,
        );
      }
      throw new AgentTabError(
        `${error instanceof Error ? error.message : String(error)}; layout rollback failed, so the visible tab was persisted as ${liveTarget.id}`,
        500,
      );
    }
    try {
      await ensured.rollback();
    } catch (rollbackError) {
      throw new AgentTabError(
        `${error instanceof Error ? error.message : String(error)}; resumed-pane rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        500,
      );
    }
    throw error;
  }
}

export async function selectAgentTab(
  context: ResolvedAgentSessionContext,
  branch: string,
  tabId: string,
  options: AgentTabOptions = {},
): Promise<void> {
  await withWorktreeBranchLock(
    context.projectId,
    branch,
    async () =>
      selectAgentTabUnlocked(context, await prepare(context, branch, options), tabId, options),
    { lockDir: context.deps.worktreeLockDir },
  );
}

export async function deleteAgentTab(
  context: ResolvedAgentSessionContext,
  branch: string,
  tabId: string,
  options: AgentTabOptions = {},
): Promise<void> {
  await withWorktreeBranchLock(
    context.projectId,
    branch,
    async () => {
      const prepared = await prepare(context, branch, options);
      const projection = projectAgentSessionTabs(prepared.sessions, prepared.binding);
      const target = prepared.sessions.find((session) => session.id === tabId);
      if (target === undefined || !projection.tabs.some((tab) => tab.tabId === tabId)) {
        throw new AgentTabError(`Tab not found: ${tabId}`, 404);
      }
      if (target.id === prepared.root.id) {
        throw new AgentTabError('The root tab cannot be deleted.', 400);
      }
      if ((await inspectPaneOwnership(context, prepared, target)).kind === 'foreign') {
        throw new AgentTabError(`Pane ownership changed for session ${target.id}.`, 409);
      }
      if (projection.activeTabId === target.id) {
        // Recovery is part of the precondition: never kill the active fork and
        // leave the binding pointing at a root that still has no pane.
        await selectAgentTabUnlocked(context, prepared, prepared.root.id, options);
      }
      // Stop intent is durable before the destructive call. If tmux fails, put
      // the row back; if that compensation also fails, report both failures.
      await updateSessionStatus(context.storage, target, 'stopped', () => nowOf(context, options));
      try {
        const ownership = await inspectPaneOwnership(context, prepared, target);
        if (ownership.kind === 'foreign') {
          throw new AgentTabError(`Pane ownership changed for session ${target.id}.`, 409);
        }
        if (ownership.kind === 'owned') {
          await requireTabTmux(context).killPaneStrict(ownership.identity.paneId);
        }
      } catch (error) {
        try {
          await saveSession(context.storage, target);
        } catch (rollbackError) {
          throw new AgentTabError(
            `${error instanceof Error ? error.message : String(error)}; stop-intent rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            500,
          );
        }
        throw error;
      }
    },
    { lockDir: context.deps.worktreeLockDir },
  );
}

function agentPaneIndex(context: ResolvedAgentSessionContext): number {
  return context.deps.panes.findIndex((pane) => pane.kind === 'agent') < 0
    ? 0
    : context.deps.panes.findIndex((pane) => pane.kind === 'agent');
}

interface EnsuredAgentTabPane {
  session: AgentSession;
  mode: SessionLayoutMode;
  rollback: () => Promise<void>;
}

async function ensureAgentTabPane(
  context: ResolvedAgentSessionContext,
  prepared: PreparedTabs,
  target: AgentSession,
  options: AgentTabOptions,
): Promise<EnsuredAgentTabPane> {
  assertForkable(target.provider);
  if (target.conversationId === null) {
    throw new AgentTabError(
      `The ${target.provider} conversation id for tab ${target.id} has not been recorded yet.`,
      409,
    );
  }
  const tmux = requireTabTmux(context);
  if ((await ownedPaneIdentity(context, prepared, target)) !== null) {
    return { session: target, mode: 'reattach', rollback: async () => {} };
  }

  const argv = buildTtyAgentArgv({
    provider: target.provider,
    permission: target.permission,
    launchMode: 'resume',
    resumeConversationId: target.conversationId,
  });
  const windowExists = await tmux.hasWindowStrict(prepared.sessionName, prepared.windowName);
  let paneId: string;
  const paneToken = target.paneToken ?? randomUUID();
  let mode: SessionLayoutMode = 'resume';
  let createdWholeWindow = false;
  if (windowExists === false) {
    const plan = planSessionLayout({
      projectId: context.projectId,
      branch: target.branch,
      templates: [...context.deps.panes],
      context: {
        repoRoot: context.projectRoot,
        worktreePath: prepared.path,
        paneCommands: {
          agent: buildPaneCommand({ argv, runtimeEnvPath: prepared.runtimeEnvPath }),
          shell: buildManagedShellCommand(prepared.runtimeEnvPath, context.deps.shellPath),
        },
      },
    });
    const layout = await ensureSessionLayout(context.deps.tmux, plan);
    mode = layout.mode;
    createdWholeWindow = true;
    paneId = await context.deps.tmux.getPaneId(
      `${prepared.sessionName}:${prepared.windowName}.${agentPaneIndex(context)}`,
    );
    await tmux.tagPaneOwner(paneId, paneToken, prepared.sessionName);
  } else {
    paneId = await tmux.createParkedPane({
      sessionName: prepared.sessionName,
      parkingWindow: prepared.parkingWindow,
      cwd: prepared.path,
      command: buildManagedShellCommand(prepared.runtimeEnvPath, context.deps.shellPath),
    });
    try {
      await tmux.tagPaneOwner(paneId, paneToken, prepared.sessionName);
      await tmux.runCommand(
        paneId,
        buildPaneCommand({ argv, runtimeEnvPath: prepared.runtimeEnvPath }),
      );
    } catch (error) {
      const cleanup = await killOwnedPane(context, prepared, {
        ...target,
        paneTarget: paneId,
        paneToken,
      }).catch((cleanupError) => cleanupError);
      if (cleanup !== true) {
        throw new AgentTabError(
          `${error instanceof Error ? error.message : String(error)}; resumed-pane cleanup failed: ${cleanup instanceof Error ? cleanup.message : 'pane ownership changed'}`,
          500,
        );
      }
      throw error;
    }
  }
  const resumed: AgentSession = {
    ...target,
    paneTarget: paneId,
    paneToken,
    status: 'starting',
    endedAt: null,
    updatedAt: nowOf(context, options).toISOString(),
  };
  try {
    await saveSession(context.storage, resumed);
  } catch (error) {
    try {
      if (createdWholeWindow) {
        if ((await ownedPaneIdentity(context, prepared, resumed)) === null) {
          throw new Error(`pane ownership changed for ${resumed.id}; window was preserved`);
        }
        await context.deps.tmux.killWindow(prepared.sessionName, prepared.windowName);
      } else if (!(await killOwnedPane(context, prepared, resumed))) {
        throw new Error(`pane ownership changed for ${resumed.id}; foreign pane was preserved`);
      }
    } catch (cleanupError) {
      throw new AgentTabError(
        `${error instanceof Error ? error.message : String(error)}; resume persistence cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        500,
      );
    }
    throw error;
  }
  return {
    session: resumed,
    mode,
    rollback: async () => {
      if (createdWholeWindow) {
        if ((await ownedPaneIdentity(context, prepared, resumed)) === null) {
          throw new Error(`pane ownership changed for ${resumed.id}; window was preserved`);
        }
        await context.deps.tmux.killWindow(prepared.sessionName, prepared.windowName);
      } else {
        if (!(await killOwnedPane(context, prepared, resumed))) {
          throw new Error(`pane ownership changed for ${resumed.id}; foreign pane was preserved`);
        }
      }
      await saveSession(context.storage, target);
    },
  };
}

export async function refreshActiveAgentTab(
  context: ResolvedAgentSessionContext,
  branch: string,
  options: AgentTabOptions = {},
): Promise<{ sessionId: string; mode: SessionLayoutMode }> {
  return await withWorktreeBranchLock(
    context.projectId,
    branch,
    async () => {
      const prepared = await prepare(context, branch, options);
      const projection = projectAgentSessionTabs(prepared.sessions, prepared.binding);
      const active = projection.activeSession ?? prepared.root;
      const ensured = await ensureAgentTabPane(context, prepared, active, options);
      prepared.sessions = prepared.sessions.map((session) =>
        session.id === ensured.session.id ? ensured.session : session,
      );
      try {
        await bringToFront(context, prepared, ensured.session.paneTarget as string, active);
        return { sessionId: ensured.session.id, mode: ensured.mode };
      } catch (error) {
        try {
          await ensured.rollback();
        } catch (rollbackError) {
          throw new AgentTabError(
            `${error instanceof Error ? error.message : String(error)}; refresh rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            500,
          );
        }
        throw error;
      }
    },
    { lockDir: context.deps.worktreeLockDir },
  );
}

/**
 * Reconcile pane identity in two aggregated tmux reads.
 *
 * A missing pane demotes the row to `orphaned`; it never deletes it. Legacy
 * root rows used a named target, so their liveness falls back to the aggregate
 * window inventory until the first tab operation upgrades them to `%N`.
 */
export async function reconcileAgentTabPanes(
  context: Pick<ResolvedAgentSessionContext, 'projectId' | 'storage' | 'deps'>,
  sessions: readonly AgentSession[],
  options: AgentTabOptions = {},
): Promise<AgentSession[]> {
  const reconciliationNow = (): Date => (options.now ?? context.deps.now ?? (() => new Date()))();
  const locationsRead = context.deps.tmux.listPaneLocations;
  if (locationsRead === undefined) return [...sessions];
  const branches = [...new Set(sessions.map((session) => session.branch))].sort();

  const underLocks = async (
    index: number,
    operation: () => Promise<AgentSession[]>,
  ): Promise<AgentSession[]> => {
    const branch = branches[index];
    if (branch === undefined) return await operation();
    return await withWorktreeBranchLock(
      context.projectId,
      branch,
      () => underLocks(index + 1, operation),
      { lockDir: context.deps.worktreeLockDir },
    );
  };

  return await underLocks(0, async () => {
    let locations: Awaited<ReturnType<NonNullable<typeof locationsRead>>>;
    try {
      locations = await locationsRead.call(context.deps.tmux);
    } catch {
      // Unknown is not absent. A transient tmux error must never rewrite durable
      // liveness as orphaned.
      return [...sessions];
    }
    // Only mutate the branches whose locks were acquired. A branch created
    // after the inventory above must wait for the next reconciliation pass.
    const fresh = (await listSessions(context.storage)).filter((session) =>
      branches.includes(session.branch),
    );
    const paneLocations = new Map(locations.map((entry) => [entry.paneId, entry]));
    const sessionName = buildProjectSessionName(context.projectId);
    const managed = await context.deps.worktrees.list().catch(() => []);
    const bindingById = new Map(
      managed.flatMap((worktree) =>
        worktree.binding === null ? [] : [[worktree.binding.worktreeId, worktree.binding] as const],
      ),
    );
    const result: AgentSession[] = [];
    for (const session of fresh) {
      const binding = session.worktreeId === null ? undefined : bindingById.get(session.worktreeId);
      const location =
        session.paneTarget?.startsWith('%') === true
          ? paneLocations.get(session.paneTarget)
          : undefined;
      const authenticated =
        binding !== undefined &&
        location?.sessionName === sessionName &&
        (location.windowName === buildWorktreeWindowName(session.branch) ||
          location.windowName === buildWorktreeParkingWindowName(binding.worktreeId)) &&
        session.paneToken !== null &&
        location.ownerToken === session.paneToken;
      const legacyUnknown = session.paneTarget !== null && !session.paneTarget.startsWith('%');
      if (isLiveSession(session) && !authenticated && !legacyUnknown) {
        result.push(
          await updateSessionStatus(context.storage, session, 'orphaned', reconciliationNow),
        );
      } else {
        result.push(session);
      }
    }

    // A crash can land between swap and binding persistence in either order.
    // The pane occupying the visible worktree window is authoritative; repair
    // only the active pointer, never a process.
    for (const worktree of managed) {
      const binding = worktree.binding;
      if (binding === null) continue;
      const scoped = result.filter(
        (session) =>
          session.worktreeId === binding.worktreeId && session.branch === worktree.branch,
      );
      const projection = projectAgentSessionTabs(scoped, binding);
      const tabIds = new Set(projection.tabs.map((tab) => tab.tabId));
      const visible = scoped.find((session) => {
        if (!tabIds.has(session.id) || session.paneTarget?.startsWith('%') !== true) return false;
        const location = paneLocations.get(session.paneTarget);
        return (
          location?.sessionName === sessionName &&
          location.windowName === buildWorktreeWindowName(worktree.branch) &&
          location.ownerToken === session.paneToken
        );
      });
      if (visible !== undefined && visible.id !== binding.activeAgentSessionId) {
        await saveWorktree(context.storage, {
          ...binding,
          activeAgentSessionId: visible.id,
          updatedAt: reconciliationNow().toISOString(),
        });
      }
    }
    return result;
  });
}
