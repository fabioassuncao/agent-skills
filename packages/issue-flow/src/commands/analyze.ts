import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { runHeadless } from '../core/headless.js';
import { applyPlaceholders, loadPrompt } from '../core/prompt-resolver.js';
import { publishPhaseMetrics } from '../core/session-metrics.js';
import { loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { getGlobalTimeout } from '../core/verbose.js';
import { issuePlaceholders, resolveCommandIssue } from '../issues/context.js';
import type { ResolvedIssue } from '../issues/types.js';
import { resolveIssuePaths } from '../storage/resolve.js';
import { printError, printInfo, printSuccess } from '../ui/logger.js';

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
    __ISSUE_NUMBER__: issueNumber,
    __ANALYSIS_PATH__: analysisPath,
    // Last: the Issue content is substituted in but never scanned again, so a
    // body that happens to contain a placeholder is left untouched.
    ...issuePlaceholders(resolution.resolved),
  });

  const startedAtMs = Date.now();
  const result = await runHeadless({
    prompt,
    maxTurns: 30,
    timeout: getGlobalTimeout() ?? 300_000,
    // json (not text) so the CLI reports usage: the envelope's `result` field
    // carries the same assistant text this phase already consumed.
    outputFormat: 'json',
    allowedTools: ['Bash', 'Read', 'Glob', 'Grep', 'Write'],
    addDirs: [paths.issueDir],
    statusMessage: `Analyzing issue #${issueNumber}...`,
  });
  // Before the success check: the tokens were spent either way.
  publishPhaseMetrics('analyze', result.cost, startedAtMs);

  if (!result.success) {
    printError(`Analysis failed: ${result.error}`);
    return 1;
  }

  // Verify the file was created
  try {
    const content = await readFile(analysisPath, 'utf-8');
    if (content.length < 10) {
      printError('Analysis file was created but appears empty');
      return 1;
    }
  } catch {
    // File wasn't created by headless — save the result as analysis
    printInfo('Headless did not create analysis file; saving output directly');
    await writeFile(analysisPath, result.result, 'utf-8');
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
