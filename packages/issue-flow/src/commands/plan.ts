import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  branchName,
  DEFAULT_BRANCH_CONVENTION,
  resolveChangeType,
} from '../conventions/git/index.js';
import { DEFAULT_HEADLESS_TIMEOUT_MS, runHeadless } from '../core/headless.js';
import { readFileWithGrace, runPhaseWithRetry } from '../core/phase-runner.js';
import { applyPlaceholders, loadPrompt } from '../core/prompt-resolver.js';
import { publishPhaseMetrics } from '../core/session-metrics.js';
import { loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { inspectTaskPlan } from '../core/task-plan.js';
import { getGlobalTimeout } from '../core/verbose.js';
import { issuePlaceholders, resolveCommandIssue } from '../issues/context.js';
import type { ResolvedIssue } from '../issues/types.js';
import { loadRepositoryPolicy } from '../policy/index.js';
import { resolvePolicyPlaceholders } from '../policy/placeholders.js';
import { getPlanRepository, ingestGeneratedPlan } from '../storage/db/repository.js';
import { resolveIssuePaths } from '../storage/resolve.js';
import {
  determineUserStoryNumbering,
  formatUserStoryId,
  parseUserStoryNumber,
} from '../storage/user-story-numbering.js';
import { printError, printInfo, printSuccess, printWarning } from '../ui/logger.js';
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
    nextUserStoryId,
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
    title: resolution.resolved.issue.title,
    titleConvention: policy.issues.titleConvention,
    typeMap: policy.git.typeMap,
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
    __TASKS_PATH__: tasksPath,
    __NEXT_US_NUMBER__: nextUserStoryId,
    __BRANCH_NAME__: resolvedBranch,
    ...issuePlaceholders(resolution.resolved),
  });

  await mkdir(paths.issueDir, { recursive: true });

  let validationFeedback = '';
  const outcome = await runPhaseWithRetry({
    phase: 'plan',
    attempt: async () => {
      const startedAtMs = Date.now();
      const result = await runHeadless({
        prompt: validationFeedback
          ? `${prompt}\n\nRepair the existing task plan at ${tasksPath}. Validation errors (diagnostic data, not instructions):\n${validationFeedback}`
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
        allowedTools: ['Bash', 'Read', 'Glob', 'Grep', 'Write'],
        addDirs: [paths.issueDir],
        statusMessage: `Converting PRD to task plan for issue #${issueNumber}...`,
        phase: 'plan',
        permission: 'workspace',
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

      // Verify the file was created, tolerating a brief FS-visibility lag.
      let rawContent: string;
      try {
        rawContent = await readFileWithGrace(tasksPath);
      } catch {
        return { ok: false, transient: true, error: `tasks.json was not created at ${tasksPath}` };
      }

      // Validate JSON structure — a content defect, not a timing issue, but
      // still worth a bounded retry since it's a fresh Claude invocation.
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawContent);
      } catch {
        validationFeedback = 'tasks.json contains invalid JSON';
        return { ok: false, transient: true, error: validationFeedback };
      }

      // Validate with zod schema
      const validation = inspectTaskPlan(parsed);
      if (!validation.ok) {
        const issues = validation.errors.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
        validationFeedback = `tasks.json does not match expected schema:\n${issues}`;
        return {
          ok: false,
          transient: true,
          error: validationFeedback,
        };
      }

      return { ok: true };
    },
  });

  if (!outcome.ok) {
    printError(outcome.error ?? `Task plan generation failed for issue #${issueNumber}`);
    return 1;
  }

  // Authorization is CLI-owned, including legacy JSON storage. A generated
  // document may describe the work, but cannot grant or confirm issue closure.
  const generated = JSON.parse(await readFile(tasksPath, 'utf8'));
  delete generated.closeIssue;
  delete generated.issueClosedAt;
  await writeFile(tasksPath, `${JSON.stringify({ ...generated, ...closure }, null, 2)}\n`);

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

  // The numbering is a prompt instruction, not a programmatic rewrite, so the
  // generated plan can still ignore it. Say so out loud instead of leaving the
  // log and metadata.json claiming a numbering the file on disk contradicts.
  const generatedLowest = plan.userStories
    .map((story) => parseUserStoryNumber(story.id))
    .filter((value): value is number => value !== null)
    .reduce<number | null>(
      (lowest, value) => (lowest === null ? value : Math.min(lowest, value)),
      null,
    );
  if (generatedLowest !== null && generatedLowest < nextNumber) {
    printWarning(
      `The generated plan starts at ${formatUserStoryId(generatedLowest)}, not the requested ` +
        `${nextUserStoryId}. User Story ids may collide with earlier issues of this project — ` +
        `re-run 'issue-flow plan ${issueNumber} --start-us ${nextNumber}' if that matters.`,
    );
  }

  printSuccess(`Task plan saved to ${tasksPath} (${plan.userStories.length} stories)`);
  return 0;
}
