import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runHeadless } from '../core/headless.js';
import { readFileWithGrace, runPhaseWithRetry } from '../core/phase-runner.js';
import { applyPlaceholders, loadPrompt } from '../core/prompt-resolver.js';
import { loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { getGlobalTimeout } from '../core/verbose.js';
import { taskPlanSchema } from '../schemas.js';
import { printError, printSuccess } from '../ui/logger.js';
import { isTransientFailure } from '../utils/retry.js';

export async function runPlan(issue: string): Promise<number> {
  const issueNumber = issue.replace(/^#/, '');
  const issueDir = join('issues', issueNumber);

  // Read the PRD
  const prdPath = join(issueDir, 'prd.md');
  let prdContent: string;
  try {
    prdContent = await readFile(prdPath, 'utf-8');
  } catch {
    printError(`PRD not found at ${prdPath}. Run 'issue-flow prd ${issueNumber}' first.`);
    return 1;
  }

  const tasksPath = join(issueDir, 'tasks.json');

  const template = await loadPrompt('plan');
  const prompt = applyPlaceholders(template, {
    __ISSUE_NUMBER__: issueNumber,
    __PRD_CONTENT__: prdContent,
    __TASKS_PATH__: tasksPath,
  });

  await mkdir(issueDir, { recursive: true });

  const outcome = await runPhaseWithRetry({
    phase: 'plan',
    attempt: async () => {
      const result = await runHeadless({
        prompt,
        maxTurns: 25,
        timeout: getGlobalTimeout() ?? 300_000,
        outputFormat: 'text',
        allowedTools: ['Bash', 'Read', 'Glob', 'Grep', 'Write'],
        statusMessage: `Converting PRD to task plan for issue #${issueNumber}...`,
      });

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

  printSuccess(`Task plan saved to ${tasksPath} (${plan.userStories.length} stories)`);
  return 0;
}
