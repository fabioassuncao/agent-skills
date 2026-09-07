import { randomUUID } from 'node:crypto';
import type { PlanRepositoryContext } from '../../storage/db/repository.js';
import {
  deleteAgentSession,
  listStoredAgentSessions,
  loadStoredAgentSession,
  type StoredAgentSession,
  saveAgentSession,
} from '../../storage/db/repository.js';
import { type AgentPermission, type AgentPhase, isAgentPhase } from '../types.js';
import type { AgentSession, AgentSessionStatus } from './types.js';

/**
 * Persistence for the link between a conversation and what it is being used for.
 *
 * Thin on purpose: the interesting decisions are in `reuse.ts`, and everything
 * here is the storage boundary. It writes nothing the outside world is the
 * authority on (ADR-08) — the conversation lives with the provider, the pane
 * lives in tmux, and a session whose pane is gone is marked `orphaned` by
 * reconciliation rather than deleted here.
 */

export interface CreateAgentSessionInput {
  branch: string;
  provider: string;
  permission?: AgentPermission;
  runId?: string | null;
  phase?: AgentPhase | null;
  storyId?: string | null;
  worktreeId?: string | null;
  conversationId?: string | null;
  paneTarget?: string | null;
  paneToken?: string | null;
  parentSessionId?: string | null;
  tabSequence?: number;
  /** Caption for a session no issue names. Free sessions are why it exists. */
  label?: string | null;
  status?: AgentSessionStatus;
  now?: () => Date;
}

export function createAgentSession(input: CreateAgentSessionInput): AgentSession {
  const at = (input.now ?? (() => new Date()))().toISOString();
  return {
    id: randomUUID(),
    runId: input.runId ?? null,
    phase: input.phase ?? null,
    storyId: input.storyId ?? null,
    branch: input.branch,
    worktreeId: input.worktreeId ?? null,
    provider: input.provider,
    permission: input.permission ?? 'workspace',
    conversationId: input.conversationId ?? null,
    status: input.status ?? 'starting',
    paneTarget: input.paneTarget ?? null,
    paneToken: input.paneToken ?? randomUUID(),
    parentSessionId: input.parentSessionId ?? null,
    tabSequence: input.tabSequence ?? 0,
    label: input.label ?? null,
    createdAt: at,
    updatedAt: at,
    endedAt: null,
  };
}

export async function saveSession(
  context: PlanRepositoryContext,
  session: AgentSession,
): Promise<void> {
  await saveAgentSession(context, session);
}

/**
 * Narrow a stored row into the domain shape.
 *
 * The row's `phase` and `provider` are plain strings — the database can hold a
 * value written by a newer release, and a cast would let it reach code that
 * switches on it exhaustively. An unrecognised phase becomes `null` (the row is
 * still a session, it just is not one of *these* phases); an unrecognised
 * provider remains a string because custom-agent ids are deliberately open.
 */
function toAgentSession(row: StoredAgentSession): AgentSession | null {
  if (row.provider.trim() === '') return null;
  return {
    ...row,
    phase: row.phase !== null && isAgentPhase(row.phase) ? row.phase : null,
    provider: row.provider,
  };
}

export async function loadSession(
  context: PlanRepositoryContext,
  id: string,
): Promise<AgentSession | null> {
  const row = await loadStoredAgentSession(context, id);
  return row === null ? null : toAgentSession(row);
}

export async function listSessions(
  context: PlanRepositoryContext,
  filter: { branch?: string; runId?: string } = {},
): Promise<AgentSession[]> {
  return (await listStoredAgentSessions(context, filter))
    .map(toAgentSession)
    .filter((session): session is AgentSession => session !== null);
}

export async function removeSession(context: PlanRepositoryContext, id: string): Promise<void> {
  await deleteAgentSession(context, id);
}

/**
 * Record the provider's own conversation id.
 *
 * Separate from a general update because it is the field that decides whether a
 * session can be resumed at all, and it arrives later than the rest — the
 * provider only reports it once the conversation exists.
 */
export async function recordConversationId(
  context: PlanRepositoryContext,
  session: AgentSession,
  conversationId: string,
  now: () => Date = () => new Date(),
): Promise<AgentSession> {
  const next: AgentSession = {
    ...session,
    conversationId,
    updatedAt: now().toISOString(),
  };
  await saveAgentSession(context, next);
  return next;
}

/**
 * Record where the session's agent is running.
 *
 * Written after the pane exists, never before: `pane_target` is a claim about
 * tmux, and tmux is the authority on it (ADR-08). A row pointing at a pane that
 * was never created would send the next prompt into whatever occupies that
 * target instead.
 */
export async function recordPaneTarget(
  context: PlanRepositoryContext,
  session: AgentSession,
  paneTarget: string | null,
  now: () => Date = () => new Date(),
): Promise<AgentSession> {
  const next: AgentSession = { ...session, paneTarget, updatedAt: now().toISOString() };
  await saveAgentSession(context, next);
  return next;
}

/**
 * Promote a free session to a workflow one by binding it to a run.
 *
 * The whole of "mode 2 becomes mode 1" (§49.2). Everything that carries the
 * session's history — its id, its conversation id, its branch, its pane and its
 * `createdAt` — is left exactly as it was, because the point of promoting a
 * session instead of opening a new one is that the conversation continues.
 *
 * The run has to exist already. Minting one here would be this module deciding
 * that work is underway, and whether work is underway is not something a
 * binding table gets to assert (ADR-08); it would also be a session starting
 * the pipeline on its own, which §49.2 forbids outright.
 */
export async function linkSessionToRun(
  context: PlanRepositoryContext,
  session: AgentSession,
  runId: string,
  options: { phase?: AgentPhase | null; storyId?: string | null; now?: () => Date } = {},
): Promise<AgentSession> {
  const next: AgentSession = {
    ...session,
    runId,
    phase: options.phase ?? session.phase,
    storyId: options.storyId ?? session.storyId,
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  await saveAgentSession(context, next);
  return next;
}

/** Move a session's status, stamping `endedAt` when it stops for good. */
export async function updateSessionStatus(
  context: PlanRepositoryContext,
  session: AgentSession,
  status: AgentSessionStatus,
  now: () => Date = () => new Date(),
): Promise<AgentSession> {
  const at = now().toISOString();
  const next: AgentSession = {
    ...session,
    status,
    updatedAt: at,
    endedAt: status === 'stopped' || status === 'orphaned' ? (session.endedAt ?? at) : null,
  };
  await saveAgentSession(context, next);
  return next;
}
