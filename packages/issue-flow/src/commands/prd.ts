import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runHeadless } from '../core/headless.js';
import { readFileWithGrace, runPhaseWithRetry } from '../core/phase-runner.js';
import { applyPlaceholders, loadPrompt } from '../core/prompt-resolver.js';
import { loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { getGlobalTimeout } from '../core/verbose.js';
import { printError, printSuccess } from '../ui/logger.js';
import { isTransientFailure } from '../utils/retry.js';

export async function runPrd(issue: string): Promise<number> {
  const issueNumber = issue.replace(/^#/, '');
  const issueDir = join('issues', issueNumber);
  const prdPath = join(issueDir, 'prd.md');

  await mkdir(issueDir, { recursive: true });

  const template = await loadPrompt('prd');
  const prompt = applyPlaceholders(template, {
    __ISSUE_NUMBER__: issueNumber,
    __PRD_PATH__: prdPath,
  });

  const outcome = await runPhaseWithRetry({
    phase: 'prd',
    attempt: async () => {
      const result = await runHeadless({
        prompt,
        maxTurns: 25,
        timeout: getGlobalTimeout() ?? 300_000,
        outputFormat: 'text',
        allowedTools: ['Bash', 'Read', 'Glob', 'Grep', 'Write'],
        statusMessage: `Generating PRD for issue #${issueNumber}...`,
      });

      if (!result.success) {
        return {
          ok: false,
          transient: isTransientFailure(1, result.error ?? ''),
          error: `PRD generation failed: ${result.error}`,
        };
      }

      // Verify the file was created. A brief grace period absorbs a lag
      // between the Write tool completing and this process seeing it; if it
      // still isn't there, treat it as recoverable and let the phase retry.
      try {
        const content = await readFileWithGrace(prdPath);
        if (content.length < 10) {
          return { ok: false, transient: true, error: 'PRD file was created but appears empty' };
        }
      } catch {
        return { ok: false, transient: true, error: `PRD file was not created at ${prdPath}` };
      }

      return { ok: true };
    },
  });

  if (!outcome.ok) {
    printError(outcome.error ?? `PRD generation failed for issue #${issueNumber}`);
    return 1;
  }

  // Update pipeline state
  const tasksPath = join(issueDir, 'tasks.json');
  try {
    const plan = await loadTaskPlan(tasksPath);
    plan.pipeline.prdCompleted = true;
    await saveTaskPlan(tasksPath, plan);
  } catch {
    // tasks.json may not exist yet
  }

  printSuccess(`PRD saved to ${prdPath}`);
  return 0;
}
