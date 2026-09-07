export type AgentRuntimeEventType =
  | 'agent_stopped'
  | 'agent_status_changed'
  | 'pr_opened'
  | 'runtime_error';

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
