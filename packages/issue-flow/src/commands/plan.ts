import { mkdir, readFile } from 'node:fs/promises';
import { runHeadless } from '../core/headless.js';
import { readFileWithGrace, runPhaseWithRetry } from '../core/phase-runner.js';
import { applyPlaceholders, loadPrompt } from '../core/prompt-resolver.js';
import { publishPhaseMetrics } from '../core/session-metrics.js';
import { loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { getGlobalTimeout } from '../core/verbose.js';
import { issuePlaceholders, resolveCommandIssue } from '../issues/context.js';
import type { ResolvedIssue } from '../issues/types.js';
import { resolvePolicyPlaceholders } from '../policy/placeholders.js';
import { taskPlanSchema } from '../schemas.js';
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

  const template = await loadPrompt('plan');
  const prompt = applyPlaceholders(template, {
    // The repository's own conventions. Empty when it declares none, which is
    // what keeps the rendered prompt identical to the pre-policy one.
    ...(await resolvePolicyPlaceholders()),
    __ISSUE_NUMBER__: issueNumber,
    __PRD_CONTENT__: prdContent,
    __TASKS_PATH__: tasksPath,
    __NEXT_US_NUMBER__: nextUserStoryId,
    ...issuePlaceholders(resolution.resolved),
  });

  await mkdir(paths.issueDir, { recursive: true });

  const outcome = await runPhaseWithRetry({
    phase: 'plan',
    attempt: async () => {
      const startedAtMs = Date.now();
      const result = await runHeadless({
        prompt,
        maxTurns: 25,
        timeout: getGlobalTimeout() ?? 300_000,
        // json (not text) so the CLI reports usage: the envelope's `result`
        // field carries the same assistant text this phase already consumed.
        outputFormat: 'json',
        allowedTools: ['Bash', 'Read', 'Glob', 'Grep', 'Write'],
        addDirs: [paths.issueDir],
        statusMessage: `Converting PRD to task plan for issue #${issueNumber}...`,
      });
      // One event per attempt; the reducer sums them into the phase total.
      publishPhaseMetrics('plan', result.cost, startedAtMs);

      if (!result.success) {
        return {
          ok: false,
          transient: isTransientFailure(1, result.error ?? ''),
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
        return { ok: false, transient: true, error: 'tasks.json contains invalid JSON' };
      }

      // Validate with zod schema
      const validation = taskPlanSchema.safeParse(parsed);
      if (!validation.success) {
        const issues = validation.error.issues
          .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
          .join('\n');
        return {
          ok: false,
          transient: true,
          error: `tasks.json does not match expected schema:\n${issues}`,
        };
      }

      return { ok: true };
    },
  });

  if (!outcome.ok) {
    printError(outcome.error ?? `Task plan generation failed for issue #${issueNumber}`);
    return 1;
  }

  // Ensure pipeline state reflects completion of this phase
  const plan = await loadTaskPlan(tasksPath);
  plan.pipeline.jsonCompleted = true;
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
