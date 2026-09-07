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

/**
 * The end of an autonomous run, in the terms of this repository.
 *
 * `core/run-completion.ts` is the ported decision — *when* a run counts as
 * finished and what stands it down. This is the half that knows Issue Flow:
 * where the agent's signals are read from, what "close what it left open"
 * closes, and what "disarmed" means.
 *
 * **Disarm.** §32 already gave this repository the mechanism WebMux calls
 * elegant: a person touching the keyboard puts the run in `human_hold`, and
 * nothing automatic proceeds. So there is no second armed/disarmed flag here —
 * armed *is* "no human hold", and disarming a run that finished on its own is
 * simply not having one to disarm. That is the invariant-13 answer: one
 * implementation of "a person is in control", in `core/human-hold.ts`.
 *
 * **Close.** Upstream's `closeWorktree` closes the *session*, never the
 * worktree itself — the work stays on disk. The equivalent here is the run's
 * live `AgentSession` rows: they are the link between a conversation and what
 * it is being used for, and a finished run has no use for them. Nothing is
 * deleted, no branch is touched and no worktree is removed; a headless run,
 * which opens no session at all, closes nothing and is unaffected (ADR-03).
 */

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
    // A run that finished on its own has no hold to clear, and one that a
    // person is holding never reaches here. Releasing the hold would be
    // exactly the auto-resume §32 forbids, so standing down is a no-op by
    // design — the arming state is derived, never stored twice.
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

/**
 * Stop the run's live sessions.
 *
 * `stopped`, never deleted: the row is the record that the conversation
 * existed and which worktree it ran in, and `--resume` of a later run reads
 * it. Upstream closes the tmux window and leaves the worktree alone for the
 * same reason.
 */
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
