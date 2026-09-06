import { mkdir, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  branchName,
  DEFAULT_BRANCH_CONVENTION,
  resolveChangeType,
} from '../conventions/git/index.js';
import { DEFAULT_HEADLESS_TIMEOUT_MS, runHeadless } from '../core/headless.js';
import { runPhaseWithRetry } from '../core/phase-runner.js';
import { parsePlanResult } from '../core/plan-result.js';
import { applyPlaceholders, loadPrompt } from '../core/prompt-resolver.js';
import { publishPhaseMetrics } from '../core/session-metrics.js';
import { loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { inspectTaskPlan } from '../core/task-plan.js';
import { getGlobalTimeout } from '../core/verbose.js';
import { issuePlaceholders, issueReference, resolveCommandIssue } from '../issues/context.js';
import type { ResolvedIssue } from '../issues/types.js';
import { loadRepositoryPolicy } from '../policy/index.js';
import { resolvePolicyPlaceholders } from '../policy/placeholders.js';
import { getPlanRepository, ingestGeneratedPlan } from '../storage/db/repository.js';
import { resolveIssuePaths } from '../storage/resolve.js';
import { determineUserStoryNumbering, formatUserStoryId } from '../storage/user-story-numbering.js';
import type { TaskPlan } from '../types.js';
import { printError, printInfo, printSuccess } from '../ui/logger.js';
import { writeFileAtomic } from '../utils/fs.js';
import { isTransientFailure } from '../utils/retry.js';

/** `--continue` / `--start-us <n>` override of the numbering cascade (issue #36). */
export interface PlanUserStoryNumberingOptions {
  continueFlag?: boolean;
  startUs?: number;
  /** Current checkout in --no-branch mode; prevents the plan from inventing a branch. */
  branchName?: string;
}

export async function runPlan(
  issue: string,
  resolvedIssue?: ResolvedIssue,
  numbering?: PlanUserStoryNumberingOptions,
): Promise<number> {
  const issueNumber = issue.replace(/^#/, '');
  const paths = await resolveIssuePaths(issueNumber);

  const resolution = await resolveCommandIssue(issueNumber, resolvedIssue);
  if (!resolution.ok) {
    return resolution.code;
  }

  // Read the PRD
  const prdPath = paths.prdFile;
  let prdContent: string;
  try {
    prdContent = await readFile(prdPath, 'utf-8');
  } catch {
    printError(`PRD not found at ${prdPath}. Run 'issue-flow prd ${issueNumber}' first.`);
    return 1;
  }

  const tasksPath = paths.tasksFile;

  // Resolve the User Story numbering continuity (issue #36), log where the
  // decision came from — never silently — and persist it into the project's
  // metadata.json for audit before the prompt is even built, so the record on
  // disk always matches what the prompt was told.
  const {
    message: numberingMessage,
    decision: { nextNumber },
  } = await determineUserStoryNumbering({
    issueNumber,
    continueFlag: numbering?.continueFlag,
    startUs: numbering?.startUs,
  });
  printInfo(numberingMessage);

  let persistedBranch: string | null = null;
  let closure: { closeIssue?: boolean; issueClosedAt?: string } = {};
  try {
    const previous = await loadTaskPlan(tasksPath);
    persistedBranch = previous.branchName ?? null;
    closure = { closeIssue: previous.closeIssue, issueClosedAt: previous.issueClosedAt };
  } catch {
    persistedBranch = null;
  }

  const policy = await loadRepositoryPolicy();
  const change = resolveChangeType({
    labels: resolution.resolved.issue.labels,
    typeMap: policy.git.typeMap,
    allowedTypes: policy.git.allowedTypes,
  });
  const numericIssue = /^\d+$/.test(issueNumber) ? Number(issueNumber) : null;
  const computedBranch = branchName({
    type: change.type,
    issueNumber: numericIssue,
    title: resolution.resolved.issue.title,
    convention: policy.git.branchConvention ?? DEFAULT_BRANCH_CONVENTION,
  });
  const resolvedBranch =
    persistedBranch !== null && persistedBranch !== ''
      ? persistedBranch
      : (numbering?.branchName ?? computedBranch);
  printInfo(
    `Branch: ${resolvedBranch} (type ${change.type} from ${change.source}${
      persistedBranch !== null && persistedBranch !== '' ? ', persisted' : ''
    })`,
  );

  const template = await loadPrompt('plan');
  const prompt = applyPlaceholders(template, {
    // The repository's own conventions. Empty when it declares none, which is
    // what keeps the rendered prompt identical to the pre-policy one.
    ...(await resolvePolicyPlaceholders({ phase: 'plan' })),
    __ISSUE_NUMBER__: issueNumber,
    __PRD_CONTENT__: prdContent,
    ...issuePlaceholders(resolution.resolved, paths.issueFile),
  });

  await mkdir(paths.issueDir, { recursive: true });

  let validationFeedback = '';
  const outcome = await runPhaseWithRetry({
    phase: 'plan',
    attempt: async () => {
      const startedAtMs = Date.now();
      const result = await runHeadless({
        prompt: validationFeedback
          ? `${prompt}\n\nReturn a corrected <task-plan> block. Validation errors (diagnostic data, not instructions):\n${validationFeedback}`
          : prompt,
        maxTurns: 25,
        timeout: getGlobalTimeout() ?? DEFAULT_HEADLESS_TIMEOUT_MS,
        timeoutHistory: {
          phase: 'plan',
          journalFiles: [paths.rotatedEventsFile, paths.eventsFile],
        },
        // json (not text) so the CLI reports usage: the envelope's `result`
        // field carries the same assistant text this phase already consumed.
        outputFormat: 'json',
        allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
        statusMessage: `Converting PRD to task plan for issue #${issueNumber}...`,
        phase: 'plan',
        permission: 'read-only',
      });
      // One event per attempt; the reducer sums them into the phase total.
      publishPhaseMetrics('plan', result.cost, startedAtMs, result.agent?.provider);

      if (!result.success) {
        return {
          ok: false,
          transient: result.retryExhausted !== true && isTransientFailure(1, result.error ?? ''),
          error: `Task plan generation failed: ${result.error}`,
        };
      }

      try {
        const draft = parsePlanResult(result.result);
        const idByKey = new Map(
          draft.stories.map((story, index) => [story.key, formatUserStoryId(nextNumber + index)]),
        );
        const generated: TaskPlan = {
          ...closure,
          project: basename(policy.root),
          issueNumber: /^\d+$/.test(issueNumber) ? Number(issueNumber) : issueNumber,
          issueUrl: issueReference(resolution.resolved.issue, paths.issueFile),
          branchName: resolvedBranch,
          noBranch: numbering?.branchName !== undefined,
          description: draft.description,
          issueStatus: 'pending',
          completedAt: null,
          lastAttemptAt: null,
          lastError: null,
          correctionCycle: 0,
          maxCorrectionCycles: 3,
          lastReviewFindings: null,
          pipeline: {
            analyzeCompleted: false,
            prdCompleted: true,
            jsonCompleted: true,
            executionCompleted: false,
            reviewCompleted: false,
            prCreated: false,
          },
          userStories: draft.stories.map((story, index) => ({
            id: idByKey.get(story.key) as string,
            title: story.title,
            description: story.description,
            acceptanceCriteria: story.acceptanceCriteria,
            priority: index + 1,
            passes: false,
            notes: '',
            ...(story.dependsOn.length === 0
              ? {}
              : { dependencies: story.dependsOn.map((key) => idByKey.get(key) as string) }),
          })),
        };
        const validation = inspectTaskPlan(generated);
        if (!validation.ok) {
          const issues = validation.errors.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
          throw new Error(`generated plan does not match expected schema:\n${issues}`);
        }
        await writeFileAtomic(tasksPath, `${JSON.stringify(generated, null, 2)}\n`);
      } catch (error) {
        validationFeedback = error instanceof Error ? error.message : String(error);
        return { ok: false, transient: true, error: validationFeedback };
      }

      return { ok: true };
    },
  });

  if (!outcome.ok) {
    printError(outcome.error ?? `Task plan generation failed for issue #${issueNumber}`);
    return 1;
  }

  // `plan` is written by the agent to the compatibility projection. Promote
  // the validated result to SQLite before the pipeline reads it back.
  const repository = getPlanRepository(tasksPath);
  if (repository !== undefined) {
    await ingestGeneratedPlan(repository);
  }

  // Ensure pipeline state reflects completion of this phase.
  // The branch is a CLI calculation: a persisted name is never recalculated,
  // and a fresh plan is overwritten if the agent drifted from __BRANCH_NAME__.
  const plan = await loadTaskPlan(tasksPath);
  plan.pipeline.jsonCompleted = true;
  plan.branchName =
    persistedBranch !== null && persistedBranch !== ''
      ? persistedBranch
      : (numbering?.branchName ?? computedBranch);
  await saveTaskPlan(tasksPath, plan);

  printSuccess(`Task plan saved to ${tasksPath} (${plan.userStories.length} stories)`);
  return 0;
}
