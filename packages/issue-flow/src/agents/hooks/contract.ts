/**
 * Runtime events an agent's own hooks report about its lifecycle.
 *
 * Ported from WebMux `backend/src/domain/events.ts` @ d8c9d5f. The taxonomy is
 * kept at exactly four types — the upstream's, unchanged — because it is the
 * complete set an agent harness can report from a hook, and inventing a fifth
 * here would mean inventing a producer for it.
 *
 * Two deliberate differences from the upstream, both from §18 of the absorption
 * plan:
 *
 * 1. **Correlation.** WebMux keys events by `worktreeId` + `branch`, which is
 *    what it knows. Issue Flow keys them by `runId` + `phase`, which is what
 *    the pipeline knows — `runId` is the session id (`runs.id` and
 *    `runs.session_id` are the same value, see `storage/db/repository.ts`).
 * 2. **`occurredAt`.** The upstream mutates an in-memory projection, so when an
 *    event happened is the moment it arrived. These are persisted, so they
 *    carry their own timestamp.
 *
 * ADR-05 is the reason this module exists at all: agent state comes from a
 * hook, never from parsing a TTY. A parser over a TUI produces data that is
 * plausible and wrong, and it breaks on every harness release.
 */

export type AgentRuntimeEventType =
  | 'agent_stopped'
  | 'agent_status_changed'
  | 'pr_opened'
  | 'runtime_error';

/** The four states a harness hook can report. Identical to the upstream's. */
export type AgentLifecycle = 'starting' | 'running' | 'idle' | 'stopped';

export const AGENT_LIFECYCLES: readonly AgentLifecycle[] = [
  'starting',
  'running',
  'idle',
  'stopped',
];

interface AgentRuntimeEventBase {
  /** Session id of the run this event belongs to. */
  runId: string;
  /** Phase the run was executing when the hook fired. */
  phase: string;
  type: AgentRuntimeEventType;
  /** ISO-8601. Absent when the producer did not stamp one. */
  occurredAt?: string;
}

export interface AgentStoppedEvent extends AgentRuntimeEventBase {
  type: 'agent_stopped';
}

export interface AgentStatusChangedEvent extends AgentRuntimeEventBase {
  type: 'agent_status_changed';
  lifecycle: AgentLifecycle;
}

export interface PrOpenedEvent extends AgentRuntimeEventBase {
  type: 'pr_opened';
  url?: string;
}

export interface RuntimeErrorEvent extends AgentRuntimeEventBase {
  type: 'runtime_error';
  message: string;
}

export type AgentRuntimeEvent =
  | AgentStoppedEvent
  | AgentStatusChangedEvent
  | PrOpenedEvent
  | RuntimeErrorEvent;

const EVENT_TYPES: readonly string[] = [
  'agent_stopped',
  'agent_status_changed',
  'pr_opened',
  'runtime_error',
];

function hasBaseFields(
  raw: Record<string, unknown>,
): raw is Record<string, string> & { type: AgentRuntimeEventType } {
  return (
    typeof raw.runId === 'string' &&
    raw.runId.length > 0 &&
    typeof raw.phase === 'string' &&
    raw.phase.length > 0 &&
    typeof raw.type === 'string' &&
    EVENT_TYPES.includes(raw.type)
  );
}

function occurredAt(raw: Record<string, unknown>): { occurredAt?: string } {
  return typeof raw.occurredAt === 'string' && raw.occurredAt.length > 0
    ? { occurredAt: raw.occurredAt }
    : {};
}

/**
 * Validate an event received over the control endpoint.
 *
 * Returns `null` rather than throwing, and rebuilds the event field by field
 * rather than passing the parsed body through: this input crosses a process
 * boundary from a hook the user's harness invoked, so nothing unrecognised may
 * reach storage.
 */
export function parseAgentRuntimeEvent(raw: unknown): AgentRuntimeEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!hasBaseFields(raw as Record<string, unknown>)) return null;

  const event = raw as Record<string, unknown> & {
    runId: string;
    phase: string;
    type: AgentRuntimeEventType;
  };
  const base = { runId: event.runId, phase: event.phase, ...occurredAt(event) };

  switch (event.type) {
    case 'agent_stopped':
      return { ...base, type: event.type };
    case 'agent_status_changed':
      return typeof event.lifecycle === 'string' &&
        (AGENT_LIFECYCLES as readonly string[]).includes(event.lifecycle)
        ? { ...base, type: event.type, lifecycle: event.lifecycle as AgentLifecycle }
        : null;
    case 'pr_opened':
      return typeof event.url === 'string' || event.url === undefined
        ? {
            ...base,
            type: event.type,
            ...(typeof event.url === 'string' ? { url: event.url } : {}),
          }
        : null;
    case 'runtime_error':
      return typeof event.message === 'string' && event.message.length > 0
        ? { ...base, type: event.type, message: event.message }
        : null;
  }
}
