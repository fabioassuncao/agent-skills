import { existsSync } from 'node:fs';
import { publishGitState } from '../../core/session-git.js';
import type { SessionPublisher } from '../../core/session-state.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../../core/state-manager.js';
import type { ResolvedIssue } from '../../issues/types.js';
import { getPlanRepository, ingestGeneratedPlan } from '../../storage/db/repository.js';
import { printWarning } from '../../ui/logger.js';
import { getCurrentBranch, localBranchExists } from '../../utils/git.js';
import { runExecute } from '../execute.js';
import { runPlan } from '../plan.js';
import { type PrQueueContext, runPr } from '../pr.js';
import { runPrReview } from '../pr-review.js';
import { runPrd } from '../prd.js';
import { runReview } from '../review.js';
import { adoptQueueBranch } from './multi-issue.js';
import { publishInstrumentedPhaseEnd, publishStorySeed, readPrReviewOutcome } from './publish.js';
import { ensureRepositoryWritable } from './session.js';
import type { IssueSessionInput, PrReviewOutcome } from './types.js';

export interface BranchExecutionState {
  producedBranch: string | null;
  plannedExecutionBranch: string | null;
  branchExistedBeforeExecution: boolean | null;
}

export interface BuildRunnersInput {
  issueNumber: string;
  tasksPath: string;
  publisher: SessionPublisher;
  resolvedIssue: ResolvedIssue;
  queue: IssueSessionInput['queue'];
  finalPr: PrQueueContext | undefined;
  continueNumbering: boolean | undefined;
  startUs: number | undefined;
  executeRetry: { retryLimit: number | undefined; retryForever: boolean | undefined };
  effectiveNoBranch: boolean;
  effectivePrReview: boolean;
  initialBranch: string;
  queueCommitScope: string | undefined;
  branchState: BranchExecutionState;
}

function createPlanRunner(
  input: BuildRunnersInput,
  makeRunner: (fn: () => Promise<number>, phase: string) => () => Promise<void>,
): () => Promise<void> {
  const {
    issueNumber,
    tasksPath,
    publisher,
    resolvedIssue,
    queue,
    continueNumbering,
    startUs,
    effectiveNoBranch,
    effectivePrReview,
    initialBranch,
    branchState,
  } = input;
  return async () => {
    await makeRunner(
      () =>
        runPlan(issueNumber, resolvedIssue, {
          continueFlag: continueNumbering,
          startUs,
          ...(effectiveNoBranch && initialBranch ? { branchName: initialBranch } : {}),
        }),
      'plan',
    )();
    // A real plan runner already promotes its output, but test doubles and
    // alternate runners may only write the established file contract. Ingest
    // that projection before queue logic reads the canonical state back.
    const repository = getPlanRepository(tasksPath);
    if (repository !== undefined && existsSync(tasksPath)) {
      await ingestGeneratedPlan(repository);
    }
    // Read the newly-created plan once: publish its stories immediately so
    // the first execute iteration never points at a story absent from the
    // snapshot, and persist phase-selection modes from the same object.
    try {
      const plan = await loadTaskPlan(tasksPath);
      if (!effectiveNoBranch) {
        branchState.plannedExecutionBranch = plan.branchName;
        branchState.branchExistedBeforeExecution = await localBranchExists(plan.branchName).catch(
          () => null,
        );
        publisher.publish({
          type: 'git:update',
          at: isoNow(),
          branchCreated: branchState.branchExistedBeforeExecution === true ? false : null,
        });
      }
      publishStorySeed(publisher, plan.userStories, isoNow());
      if (effectiveNoBranch || effectivePrReview) {
        if (effectiveNoBranch) plan.noBranch = true;
        if (effectivePrReview) {
          plan.prReview = { ...plan.prReview, enabled: true, rounds: plan.prReview?.rounds ?? 0 };
        }
        await saveTaskPlan(tasksPath, plan);
      }
    } catch {
      /* non-critical: tasks.json may not exist yet if plan phase didn't create it */
    }
    // A queue shares one branch: the first issue's plan decides it, every
    // later issue has it written over whatever slug the agent derived from
    // its own title. The `execute` prompt then finds the branch already
    // checked out instead of creating a second one — the creation logic
    // itself is untouched.
    if (queue !== undefined && !effectiveNoBranch) {
      branchState.producedBranch = await adoptQueueBranch(tasksPath, queue.plan.branchName);
    }
  };
}

function createReviewRunner(input: BuildRunnersInput): () => Promise<void> {
  const { issueNumber, tasksPath, publisher, resolvedIssue, queueCommitScope, executeRetry } =
    input;
  return async () => {
    // Read maxCorrectionCycles
    let maxCycles = 3;
    try {
      const plan = await loadTaskPlan(tasksPath);
      maxCycles = plan.maxCorrectionCycles;
    } catch {
      /* use default */
    }

    let code = await runReview(issueNumber, resolvedIssue);

    // Auto-correction loop on failure
    let cycle = 0;
    while (code !== 0 && cycle < maxCycles) {
      cycle++;
      printWarning(`Review failed. Starting correction cycle ${cycle}/${maxCycles}...`);
      publisher.publish({ type: 'correction:cycle', at: isoNow(), cycle, maxCycles });

      // Update correction cycle in tasks.json
      try {
        const plan = await loadTaskPlan(tasksPath);
        plan.correctionCycle = cycle;
        await saveTaskPlan(tasksPath, plan);
      } catch {
        /* non-critical */
      }

      // Re-execute
      const execCode = await runExecute(undefined, {
        issue: issueNumber,
        commitScope: queueCommitScope,
        ...executeRetry,
      });
      if (execCode !== 0) {
        throw new Error('Correction execution failed');
      }

      // Re-review
      code = await runReview(issueNumber, resolvedIssue);
    }

    if (code !== 0) {
      throw new Error(`Review failed after ${maxCycles} correction cycles`);
    }
  };
}

function instrumentPhaseRunners(
  runners: Record<string, () => Promise<void>>,
  input: Pick<BuildRunnersInput, 'publisher' | 'issueNumber' | 'branchState'>,
): Record<string, () => Promise<void>> {
  const { publisher, issueNumber, branchState } = input;
  // Publish phase:start/phase:end around every runner without touching the
  // listr2 renderer (pipeline-renderer.ts stays publication-free). Commit/PR
  // enrichment happens only at these boundaries (and at iteration end, in
  // engine.ts) — never per HTTP request.
  return Object.fromEntries(
    Object.entries(runners).map(([phase, fn]) => [
      phase,
      async () => {
        publisher.publish({ type: 'phase:start', at: isoNow(), phase });
        try {
          await fn();
          if (
            phase === 'execute' &&
            branchState.branchExistedBeforeExecution === false &&
            branchState.plannedExecutionBranch !== null &&
            (await getCurrentBranch().catch(() => '')) === branchState.plannedExecutionBranch
          ) {
            publisher.publish({ type: 'git:update', at: isoNow(), branchCreated: true });
          }
          await publishGitState(publisher);
          await publishInstrumentedPhaseEnd(publisher, phase, issueNumber, true);
        } catch (err) {
          await publishGitState(publisher);
          await publishInstrumentedPhaseEnd(
            publisher,
            phase,
            issueNumber,
            false,
            err instanceof Error ? err.message : String(err),
          );
          throw err;
        }
      },
    ]),
  );
}

export function buildInstrumentedPhaseRunners(input: BuildRunnersInput): {
  instrumentedRunners: Record<string, () => Promise<void>>;
  reviewBox: { outcome: PrReviewOutcome | null };
} {
  const {
    issueNumber,
    tasksPath,
    publisher,
    resolvedIssue,
    finalPr,
    executeRetry,
    effectivePrReview,
    queueCommitScope,
    branchState,
  } = input;

  // Mutate branchState in place — runners execute later, after this function returns.

  // Build phase runner functions that throw on failure
  const makeRunner = (fn: () => Promise<number>, phase: string) => async () => {
    await ensureRepositoryWritable(phase);
    const code = await fn();
    if (code !== 0) {
      throw new Error(`Phase ${phase} failed with exit code ${code}`);
    }
  };

  const runners: Record<string, () => Promise<void>> = {
    prd: makeRunner(() => runPrd(issueNumber, resolvedIssue), 'prd'),
    plan: createPlanRunner(input, makeRunner),
    execute: makeRunner(
      () =>
        runExecute(undefined, {
          issue: issueNumber,
          commitScope: queueCommitScope,
          ...executeRetry,
        }),
      'execute',
    ),
    review: createReviewRunner(input),
    pr: async () => {
      await makeRunner(
        // The options argument is omitted outside a queue so a standalone run
        // calls `runPr` exactly as it always did.
        () =>
          finalPr === undefined
            ? runPr(issueNumber, resolvedIssue)
            : runPr(issueNumber, resolvedIssue, { queue: finalPr }),
        'pr',
      )();
      const repository = getPlanRepository(tasksPath);
      if (repository !== undefined && existsSync(tasksPath)) {
        await ingestGeneratedPlan(repository);
      }
    },
  };

  // Filled by the pr-review runner; read after the pipeline finishes. Held in a
  // box because a `let` written only inside a closure keeps its initial `null`
  // narrowing at the read site.
  const reviewBox: { outcome: PrReviewOutcome | null } = { outcome: null };
  if (effectivePrReview) {
    runners['pr-review'] = async () => {
      // `yes` because the run is autonomous: the phase must never stop to ask
      // which Pull Request it is reviewing.
      const code = await runPrReview(undefined, { issue: issueNumber, yes: true });
      if (code === 1) {
        throw new Error('Phase pr-review failed with exit code 1');
      }
      // Exit code 2 is a verdict, not a failure: the review ran, the report is
      // on disk and the pipeline keeps going.
      reviewBox.outcome = await readPrReviewOutcome(issueNumber, tasksPath, code === 2);
    };
  }

  const instrumentedRunners = instrumentPhaseRunners(runners, {
    publisher,
    issueNumber,
    branchState,
  });

  return { instrumentedRunners, reviewBox };
}
