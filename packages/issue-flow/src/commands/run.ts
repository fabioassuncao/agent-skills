import { loadRunConfig } from '../config.js';
import { backgroundRejection } from '../execution/detach.js';
import { ensureProvidersRegistered } from '../issues/bootstrap.js';
import { mintInlineIssue } from '../issues/providers/inline.js';
import { printError, printInfo } from '../ui/logger.js';
import { resolveRunDemand } from './run/demand.js';
import { detachAfterConfirm, runQueue } from './run/multi-issue.js';
import { runPipelinePhases } from './run/phases.js';
import { claimRunOwnership, runIssueSession as runIssueSessionImpl } from './run/session.js';
import type { RunIssueSession, RunPipelineOptions } from './run/types.js';

export { publishIssueDetails, publishStorySeed } from './run/publish.js';
export type { QueueFailureMode, RunPipelineOptions } from './run/types.js';

/**
 * Settle what this invocation runs, minting the Issue when the demand came in
 * as a free prompt.
 *
 * §17 of the absorption plan: `--prompt` is `webmux oneshot`'s way in, and it
 * is absorbed **as an Issue** rather than as a second execution path. By the
 * time this returns, the rest of `run` cannot tell an inline demand from a
 * GitHub one — which is the whole point of the convergence.
 */
async function resolveRequestedIssues(
  issue: string | readonly string[],
  options: RunPipelineOptions,
): Promise<string[]> {
  const demand = resolveRunDemand({
    issues: typeof issue === 'string' ? [issue] : issue,
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
  });
  if (demand.kind === 'issues') return demand.ids;

  ensureProvidersRegistered();
  const minted = await mintInlineIssue(demand.prompt);
  printInfo(`Inline demand recorded as ${minted.id}: ${minted.title}`);
  return [minted.id];
}

/** Bound session entry that closes over this module's phase orchestrator. */
const runIssueSession: RunIssueSession = (issueNumber, mode, input) =>
  runIssueSessionImpl(issueNumber, mode, input, runPipelinePhases);

/**
 * Entry point of `issue-flow run`.
 *
 * Accepts one issue (the historical form, untouched) or several. The first
 * attempt runs as a plain single-issue pipeline; only if the planner decides
 * this invocation is really a queue does it hand control over to
 * {@link runQueue} — and that decision is taken before any session is
 * published, so nothing was written on the way.
 */
export async function runPipeline(
  issue: string | readonly string[],
  mode: string,
  from?: string,
  noBranch?: boolean,
  prReview?: boolean,
  options: RunPipelineOptions = {},
): Promise<number> {
  let requested: string[];
  try {
    requested = await resolveRequestedIssues(issue, options);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    return 1;
  }

  // Resolved once, for the whole invocation: a queue is one run, and closing
  // what it left open is a decision about the run, not about each issue.
  const effectiveOptions: RunPipelineOptions =
    options.autoClose === undefined
      ? { ...options, autoClose: (await loadRunConfig()).autoClose }
      : options;

  if (options.background === true && options.detachedChild !== true) {
    const reason = backgroundRejection(mode);
    if (reason !== null) {
      printError(reason);
      return 1;
    }
    return detachAfterConfirm(requested, noBranch, prReview, effectiveOptions);
  }

  // Ownership of the run, for the whole invocation — a queue is one run, not
  // one per issue. Two invocations in the same repository share a working tree
  // and a branch, so "a different issue" is not a different lock.
  const ownership = await claimRunOwnership(requested[0] as string, options.detachedChild === true);
  if (!ownership.ok) {
    printError(ownership.refusal);
    printInfo('Wait for it to finish, or stop that process before running again.');
    return 1;
  }

  try {
    const first = await runIssueSession(requested[0] as string, mode, {
      from,
      noBranch,
      prReview,
      requested,
      runOptions: effectiveOptions,
      restartWeb: options.restartWeb,
      ...(ownership.interruptedBy === null ? {} : { interruptedBy: ownership.interruptedBy }),
    });

    if (first.queue === undefined) {
      return first.code;
    }

    return runQueue(
      first.queue.plan,
      { mode, from, noBranch, prReview, runOptions: effectiveOptions },
      first.queue.resolved,
      runIssueSession,
    );
  } finally {
    await ownership.release();
  }
}
