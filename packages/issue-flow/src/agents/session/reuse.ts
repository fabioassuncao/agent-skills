import type { AgentPhase } from '../types.js';
import type { AgentSession } from './types.js';
import { isFreeSession } from './types.js';

/**
 * Which phases may continue an existing conversation, and which may never.
 *
 * ADR-07: `review`, `pr-review` and the verification pass never reuse a
 * session — **not even when a caller asks for it explicitly**. This is not a
 * performance trade-off and it is not configurable.
 *
 * The reason is what the word "verified" is supposed to mean. A reviewer that
 * continues the conversation that wrote the code has already read its own
 * reasoning, has already agreed with itself, and will report a passing review
 * for the same reasons it wrote the code that way. Methodological independence
 * is the entire mechanism behind an acceptance verdict; reusing a session to
 * save a context re-ingestion trades the meaning of the verdict for a few
 * seconds.
 *
 * A misconfiguration that asks for it is an error, not a preference to honour —
 * which is why `assertSessionReuseAllowed` throws rather than warning.
 */

/** Phases whose independence is the point, and which therefore always start fresh. */
export const PHASES_THAT_NEVER_REUSE_A_SESSION: readonly AgentPhase[] = [
  'review',
  'pr-review',
] as const;

/** Whether a phase is allowed to continue an existing conversation. */
export function canReuseSession(phase: AgentPhase | null): boolean {
  if (phase === null) return true;
  return !(PHASES_THAT_NEVER_REUSE_A_SESSION as readonly string[]).includes(phase);
}

export class SessionReuseError extends Error {
  constructor(readonly phase: AgentPhase) {
    super(
      `Phase '${phase}' must not reuse an agent session: its independence is what makes its verdict an assertion. This is not configurable.`,
    );
    this.name = 'SessionReuseError';
  }
}

/** Throw when a phase that must stay independent is about to continue a session. */
export function assertSessionReuseAllowed(phase: AgentPhase | null): void {
  if (phase !== null && !canReuseSession(phase)) throw new SessionReuseError(phase);
}

/**
 * Pick a session to continue, or `null` to start a fresh one.
 *
 * Two independent guards, and both matter:
 *
 * 1. the phase asking must be allowed to reuse anything at all (ADR-07);
 * 2. a **free** session is never adopted by the pipeline. A person opened it and
 *    is presumably still using it; a workflow silently taking it over would
 *    interleave two conversations in one history, and would also route a
 *    verification through a conversation nobody audited.
 */
export function selectReusableSession(input: {
  phase: AgentPhase | null;
  branch: string;
  sessions: readonly AgentSession[];
}): AgentSession | null {
  if (!canReuseSession(input.phase)) return null;

  const candidates = input.sessions.filter(
    (session) =>
      session.branch === input.branch &&
      (session.parentSessionId ?? null) === null &&
      session.conversationId !== null &&
      session.status !== 'orphaned' &&
      // The pipeline never adopts a session a person opened for themselves.
      !(input.phase !== null && isFreeSession(session)),
  );
  if (candidates.length === 0) return null;

  // Most recently touched: with several, the one someone last worked in is the
  // one that carries the context worth continuing.
  return (
    [...candidates].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
  );
}
