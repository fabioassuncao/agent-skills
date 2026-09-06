import { mkdir } from 'node:fs/promises';
import { DEFAULT_HEADLESS_TIMEOUT_MS, runHeadless } from '../core/headless.js';
import { readFileWithGrace, runPhaseWithRetry } from '../core/phase-runner.js';
import { applyPlaceholders, loadPrompt } from '../core/prompt-resolver.js';
import { publishPhaseMetrics } from '../core/session-metrics.js';
import { loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { getGlobalTimeout } from '../core/verbose.js';
import { issuePlaceholders, resolveCommandIssue } from '../issues/context.js';
import type { ResolvedIssue } from '../issues/types.js';
import { resolvePolicyPlaceholders } from '../policy/placeholders.js';
import { resolveIssuePaths } from '../storage/resolve.js';
import { printError, printSuccess } from '../ui/logger.js';
import { isTransientFailure } from '../utils/retry.js';

export async function runPrd(issue: string, resolvedIssue?: ResolvedIssue): Promise<number> {
  const issueNumber = issue.replace(/^#/, '');
  const paths = await resolveIssuePaths(issueNumber);
  const prdPath = paths.prdFile;

  const resolution = await resolveCommandIssue(issueNumber, resolvedIssue);
  if (!resolution.ok) {
    return resolution.code;
  }

  await mkdir(paths.issueDir, { recursive: true });

  const template = await loadPrompt('prd');
  const prompt = applyPlaceholders(template, {
    // The repository's own conventions. Empty when it declares none, which is
    // what keeps the rendered prompt identical to the pre-policy one.
    ...(await resolvePolicyPlaceholders({ phase: 'prd' })),
    __ISSUE_NUMBER__: issueNumber,
    __PRD_PATH__: prdPath,
    // Absolute: the analysis lives in the global storage, outside the working
    // directory the agent is started in.
    __ANALYSIS_PATH__: paths.analysisFile,
    ...issuePlaceholders(resolution.resolved),
  });

  const outcome = await runPhaseWithRetry({
    phase: 'prd',
    attempt: async () => {
      const startedAtMs = Date.now();
      const result = await runHeadless({
        prompt,
        maxTurns: 25,
        timeout: getGlobalTimeout() ?? DEFAULT_HEADLESS_TIMEOUT_MS,
        timeoutHistory: {
          phase: 'prd',
          journalFiles: [paths.rotatedEventsFile, paths.eventsFile],
        },
        // json (not text) so the CLI reports usage: the envelope's `result`
        // field carries the same assistant text this phase already consumed.
        outputFormat: 'json',
        allowedTools: ['Bash', 'Read', 'Glob', 'Grep', 'Write'],
        addDirs: [paths.issueDir],
        statusMessage: `Generating PRD for issue #${issueNumber}...`,
        phase: 'prd',
        permission: 'workspace',
      });
      // One event per attempt; the reducer sums them into the phase total.
      publishPhaseMetrics('prd', result.cost, startedAtMs, result.agent?.provider);

      if (!result.success) {
        return {
          ok: false,
          transient: result.retryExhausted !== true && isTransientFailure(1, result.error ?? ''),
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
  const tasksPath = paths.tasksFile;
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
