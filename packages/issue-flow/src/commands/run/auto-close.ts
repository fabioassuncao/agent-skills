import { listSessions, updateSessionStatus } from '../../agents/session/store.js';
import { isLiveSession } from '../../agents/session/types.js';
import { currentHumanHold } from '../../core/human-hold.js';
import {
  deriveRunSignals,
  type RunCompletionTarget,
  runCompletionPass,
} from '../../core/run-completion.js';
import type { SessionPublisher } from '../../core/session-state.js';
import { isoNow } from '../../core/state-manager.js';
import { listAgentEvents, type PlanRepositoryContext } from '../../storage/db/repository.js';

export interface SettleRunOptions {
  context: PlanRepositoryContext;
  /** Session id of the run — `runs.id`. */
  runId: string;
  /** Issue the run is about, for the log line. */
  issueId: string | null;
  /** Verdict the pipeline reached. */
  outcome: 'completed' | 'failed';
  /** Whether this invocation closes what it left open. */
  autoClose: boolean;
  /** Where the decision is reported. */
  publisher?: SessionPublisher;
  now?: () => number;
}

/** Outcome of one settle, for the caller's summary and for tests. */
export interface SettleRunResult {
  settled: boolean;
  /** Live sessions that were closed. Zero for a headless run. */
  closedSessions: number;
  /** True when a person held the run and nothing automatic happened. */
  heldByHuman: boolean;
}

/**
 * Close out one finished run.
 *
 * Never throws. Everything it does is an epilogue: the pipeline's exit code is
 * already decided, and a database that cannot be read at this point must not
 * turn a successful run into a failed one.
 */
export async function settleFinishedRun(options: SettleRunOptions): Promise<SettleRunResult> {
  const { context, runId, issueId, outcome, autoClose, publisher } = options;
  let closedSessions = 0;
  let heldByHuman = false;

  const isArmed = async (id: string): Promise<boolean> => {
    try {
      const hold = await currentHumanHold(context, id);
      if (hold !== null) heldByHuman = true;
      return hold === null;
    } catch {
      // A hold that cannot be read is not evidence that a person is holding
      // the run — the same reading `core/human-hold.ts` takes. Treating it as
      // held would leave sessions open forever on a transient storage error.
      return true;
    }
  };

  let target: RunCompletionTarget = {
    runId,
    issueId,
    pipelineOutcome: outcome,
    lifecycle: null,
    hasPr: false,
  };
  try {
    const events = await listAgentEvents({
      projectId: context.projectId,
      runId,
      ...(context.databaseOptions === undefined
        ? {}
        : { databaseOptions: context.databaseOptions }),
    });
    target = { ...target, ...deriveRunSignals(events) };
  } catch {
    // No lifecycle events readable. The pipeline's own verdict is terminal on
    // its own, so the run still settles — it just settles without the agent's
    // corroboration.
  }

  const settled = await runCompletionPass({
    targets: [target],
    isArmed,
    closeRun: async (id) => {
      closedSessions = await closeRunSessions(context, id);
    },
    disarm: async () => {},
    autoClose,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  if (publisher !== undefined) {
    if (heldByHuman) {
      publisher.publish({
        type: 'log',
        at: isoNow(),
        level: 'info',
        message:
          'A person took over this run, so nothing was closed automatically. Hand control back with `issue-flow resume`.',
      });
    } else if (closedSessions > 0) {
      publisher.publish({
        type: 'log',
        at: isoNow(),
        level: 'info',
        message: `Closed ${closedSessions} agent session(s) left open by this run.`,
      });
    }
  }

  return { settled: settled > 0, closedSessions, heldByHuman };
}

async function closeRunSessions(context: PlanRepositoryContext, runId: string): Promise<number> {
  const sessions = await listSessions(context, { runId });
  let closed = 0;
  for (const session of sessions) {
    if (!isLiveSession(session)) continue;
    await updateSessionStatus(context, session, 'stopped');
    closed += 1;
  }
  return closed;
}
