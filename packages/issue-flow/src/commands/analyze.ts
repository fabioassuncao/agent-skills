import { mkdir } from 'node:fs/promises';
import { parseDocumentResult } from '../core/document-result.js';
import { DEFAULT_HEADLESS_TIMEOUT_MS, runHeadless } from '../core/headless.js';
import { applyPlaceholders, loadPrompt } from '../core/prompt-resolver.js';
import { publishPhaseMetrics } from '../core/session-metrics.js';
import { loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { getGlobalTimeout } from '../core/verbose.js';
import { issuePlaceholders, resolveCommandIssue } from '../issues/context.js';
import type { ResolvedIssue } from '../issues/types.js';
import { resolvePolicyPlaceholders } from '../policy/placeholders.js';
import { resolveIssuePaths } from '../storage/resolve.js';
import { printError, printSuccess } from '../ui/logger.js';
import { writeFileAtomic } from '../utils/fs.js';

export async function runAnalyze(issue: string, resolvedIssue?: ResolvedIssue): Promise<number> {
  const issueNumber = issue.replace(/^#/, '');
  const paths = await resolveIssuePaths(issueNumber);
  const analysisPath = paths.analysisFile;

  const resolution = await resolveCommandIssue(issueNumber, resolvedIssue);
  if (!resolution.ok) {
    return resolution.code;
  }

  await mkdir(paths.issueDir, { recursive: true });

  const template = await loadPrompt('analyze');
  const prompt = applyPlaceholders(template, {
    // The repository's own conventions. Empty when it declares none, which is
    // what keeps the rendered prompt identical to the pre-policy one.
    ...(await resolvePolicyPlaceholders({ phase: 'analyze' })),
    __ISSUE_NUMBER__: issueNumber,
    // Last: the Issue content is substituted in but never scanned again, so a
    // body that happens to contain a placeholder is left untouched.
    ...issuePlaceholders(resolution.resolved, paths.issueFile),
  });

  const startedAtMs = Date.now();
  const result = await runHeadless({
    prompt,
    maxTurns: 30,
    timeout: getGlobalTimeout() ?? DEFAULT_HEADLESS_TIMEOUT_MS,
    // json (not text) so the CLI reports usage: the envelope's `result` field
    // carries the same assistant text this phase already consumed.
    outputFormat: 'json',
    allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
    addDirs: [paths.issueDir],
    statusMessage: `Analyzing issue #${issueNumber}...`,
    phase: 'analyze',
    permission: 'read-only',
  });
  // Before the success check: the tokens were spent either way.
  publishPhaseMetrics('analyze', result.cost, startedAtMs, result.agent?.provider);

  if (!result.success) {
    printError(`Analysis failed: ${result.error}`);
    return 1;
  }

  try {
    await writeFileAtomic(analysisPath, parseDocumentResult(result.result, 'issue-analysis'));
  } catch (error) {
    printError(`Analysis output could not be parsed: ${(error as Error).message}`);
    return 1;
  }

  // Update pipeline state
  const tasksPath = paths.tasksFile;
  try {
    const plan = await loadTaskPlan(tasksPath);
    plan.pipeline.analyzeCompleted = true;
    await saveTaskPlan(tasksPath, plan);
  } catch {
    // tasks.json may not exist yet — that's OK for standalone analyze
  }

  printSuccess(`Analysis saved to ${analysisPath}`);
  return 0;
}
