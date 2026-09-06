import { randomUUID } from 'node:crypto';
import type { PlanRepositoryContext } from '../../storage/db/repository.js';
import {
  consumeStoredHandoff,
  listStoredHandoffs,
  saveStoredHandoff,
} from '../../storage/db/repository.js';
import type { AgentPhase, AgentProviderId } from '../types.js';
import { isAgentPhase, isAgentProviderId } from '../types.js';
import type { Handoff } from './types.js';

/**
 * Writing a handoff at the end of a phase, and reading it at the start of the
 * next one.
 *
 * Nothing travels through a terminal (§29). A phase writes a row; the phase
 * that follows reads it. That makes the exchange auditable after the fact —
 * which is the difference between "the reviewer saw the plan" and "the reviewer
 * probably saw the plan".
 */

export interface CreateHandoffInput {
  runId: string;
  from: { sessionId?: string | null; phase: AgentPhase; provider: AgentProviderId };
  to: { phase: AgentPhase; provider?: AgentProviderId };
  summary: string;
  nextObjective: string;
  decisions?: Handoff['decisions'];
  artifacts?: Handoff['artifacts'];
  commits?: string[];
  findings?: Handoff['findings'];
  openQuestions?: string[];
  now?: () => Date;
}

export function createHandoff(input: CreateHandoffInput): Handoff {
  return {
    id: randomUUID(),
    runId: input.runId,
    from: {
      sessionId: input.from.sessionId ?? null,
      phase: input.from.phase,
      provider: input.from.provider,
    },
    to: {
      phase: input.to.phase,
      ...(input.to.provider === undefined ? {} : { provider: input.to.provider }),
    },
    summary: input.summary,
    decisions: input.decisions ?? [],
    artifacts: input.artifacts ?? [],
    commits: input.commits ?? [],
    findings: input.findings ?? [],
    openQuestions: input.openQuestions ?? [],
    nextObjective: input.nextObjective,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    consumedAt: null,
  };
}

/** Never rejects: a handoff that cannot be written must not fail the phase that wrote it. */
export async function saveHandoff(
  context: PlanRepositoryContext,
  handoff: Handoff,
  onWarn?: (message: string) => void,
): Promise<void> {
  try {
    await saveStoredHandoff(context, {
      id: handoff.id,
      runId: handoff.runId,
      fromSessionId: handoff.from.sessionId,
      fromPhase: handoff.from.phase,
      fromProvider: handoff.from.provider,
      toPhase: handoff.to.phase,
      toProvider: handoff.to.provider ?? null,
      payload: handoff,
      createdAt: handoff.createdAt,
      consumedAt: handoff.consumedAt,
    });
  } catch (error) {
    onWarn?.(
      `issue-flow: could not persist the handoff to '${handoff.to.phase}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Narrow a stored row back into the domain shape.
 *
 * A row whose phase or provider this release does not recognise is dropped
 * rather than cast: the payload is fed into a prompt, and a value nothing
 * validated is exactly what must not reach one.
 */
function toHandoff(raw: unknown): Handoff | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Handoff;
  if (typeof candidate.id !== 'string' || typeof candidate.runId !== 'string') return null;
  if (!isAgentPhase(candidate.from?.phase) || !isAgentPhase(candidate.to?.phase)) return null;
  if (!isAgentProviderId(candidate.from?.provider)) return null;
  return candidate;
}

/** Handoffs waiting for a phase, oldest first. */
export async function pendingHandoffsFor(
  context: PlanRepositoryContext,
  input: { runId: string; phase: AgentPhase },
): Promise<Handoff[]> {
  const rows = await listStoredHandoffs(context, {
    runId: input.runId,
    toPhase: input.phase,
    pendingOnly: true,
  });
  return rows
    .map((row) => toHandoff(row.payload))
    .filter((entry): entry is Handoff => entry !== null);
}

/**
 * Mark a handoff as read.
 *
 * Separate from reading it: a phase that crashed between the two should see the
 * handoff again rather than start without the context it was given.
 */
export async function markHandoffConsumed(
  context: PlanRepositoryContext,
  id: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  await consumeStoredHandoff(context, id, now().toISOString());
}
