import { getSessionPublisher } from '../../core/session-publisher.js';
import { isoNow } from '../../core/state-manager.js';
import { getPlanRepository, recordAgentEvent } from '../../storage/db/repository.js';
import { getTelemetryContext } from '../../telemetry/recorder.js';
import type { AgentRuntimeEvent } from './contract.js';

/**
 * Turn a lifecycle event reported by an agent hook into the session events the
 * rest of Issue Flow already speaks, and persist it.
 *
 * §18 of the absorption plan is explicit that no new taxonomy is invented here:
 * the four upstream event types map onto the existing session events, and the
 * two that had no equivalent (`agent:busy`, `agent:awaiting-input`) are
 * additive.
 *
 * Two deliberate differences from the upstream, both from §18:
 *
 * - **It persists.** WebMux mutates an in-memory projection and turns the event
 *   into a notification. An `awaiting_input` that happens with nothing watching
 *   would then be gone, which is the case worth recording.
 * - **It is correlated by `runId`.** An event whose `runId` is not the session
 *   in flight is dropped, never applied: hooks outlive an invocation, and
 *   applying a stale one would move a live run's state on evidence from a dead
 *   one.
 */

export interface ApplyAgentEventOptions {
  /** Diagnostics sink. Never surfaced to the user by default. */
  onWarn?: (message: string) => void;
}

/** Never throws: this runs on the agent's hot path. */
export async function applyAgentRuntimeEvent(
  event: AgentRuntimeEvent,
  options: ApplyAgentEventOptions = {},
): Promise<void> {
  const publisher = getSessionPublisher();
  const snapshot = publisher.snapshot();
  const at = event.occurredAt ?? isoNow();

  if (snapshot.sessionId !== null && snapshot.sessionId !== event.runId) {
    options.onWarn?.(
      `issue-flow: dropped an agent event for run '${event.runId}' while '${snapshot.sessionId}' is in flight.`,
    );
    return;
  }

  switch (event.type) {
    case 'agent_status_changed':
      // `starting` and `running` are both "the agent is working". They are
      // separate upstream because its UI distinguishes a pane that is booting
      // from one that is producing; here the only decision that depends on it
      // is whether a human is being waited on.
      if (event.lifecycle === 'running' || event.lifecycle === 'starting') {
        publisher.publish({ type: 'agent:busy', at, phase: event.phase });
      } else if (event.lifecycle === 'idle') {
        publisher.publish({ type: 'agent:awaiting-input', at, phase: event.phase });
        // Also a log line: headless has no dashboard open by default, and this
        // is the one state where the run stops making progress until someone
        // acts. It has to be visible where the user is actually looking.
        publisher.publish({
          type: 'log',
          at,
          level: 'warn',
          message: `Agent is waiting for input during '${event.phase}'.`,
        });
      }
      // `stopped` publishes nothing: the end of the invocation already reports
      // it, and a second source for the same fact is a second thing to keep
      // consistent.
      break;

    case 'agent_stopped':
      break;

    case 'pr_opened':
      if (event.url !== undefined) {
        publisher.publish({
          type: 'pr:opened',
          at,
          url: event.url,
          number: pullRequestNumber(event.url),
        });
      }
      break;

    case 'runtime_error':
      publisher.publish({ type: 'log', at, level: 'error', message: event.message });
      break;
  }

  await persist(event, at, options);
}

/** Trailing `/pull/<n>` of a GitHub URL, or `null` when it is not one. */
function pullRequestNumber(url: string): number | null {
  const match = /\/pull\/(\d+)/.exec(url);
  if (match === null) return null;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function persist(
  event: AgentRuntimeEvent,
  at: string,
  options: ApplyAgentEventOptions,
): Promise<void> {
  const tasksPath = getTelemetryContext()?.tasksPath;
  if (tasksPath === undefined) return;
  const context = getPlanRepository(tasksPath);
  if (context === undefined) return;
  try {
    await recordAgentEvent(context, {
      runId: event.runId,
      phase: event.phase,
      type: event.type,
      lifecycle: event.type === 'agent_status_changed' ? event.lifecycle : null,
      payload: event,
      occurredAt: at,
    });
  } catch (error) {
    options.onWarn?.(
      `issue-flow: could not persist an agent event: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
