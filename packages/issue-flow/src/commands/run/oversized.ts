import { mkdir, writeFile } from 'node:fs/promises';
import { getActiveResilienceConfig } from '../../config.js';
import {
  assessDecomposition,
  buildDecompositionReport,
  proposeSubIssues,
} from '../../core/decompose.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../../core/state-manager.js';
import { listStoredIssueEvents } from '../../storage/db/queries.js';
import { getPlanRepository } from '../../storage/db/repository.js';
import type { IssuePaths } from '../../storage/paths.js';
import type { TaskPlan } from '../../types.js';
import { printInfo, printWarning } from '../../ui/logger.js';
import { committedStoryIds, getBaseBranch } from '../../utils/git.js';
import { run } from '../../utils/shell.js';
import type { IssueRunResult } from './types.js';

/**
 * Write a decomposition report when the failure looks like "too much work",
 * and say nothing when it does not.
 *
 * The guard that matters is the one *before* the assessment: a run that died
 * because the network went down is not too large, and reacting to that with
 * "have you considered splitting this issue?" is worse than silence. Only a
 * failure the resilience layer could not absorb — and that carries at least two
 * independent size signals — gets a report.
 *
 * Nothing is split here. The report is written and the issue is marked
 * `blocked` with a pointer to it, because splitting an issue is a product
 * decision and the tool does not get to make it.
 */
export async function reportIfOversized(
  issueNumber: string,
  paths: IssuePaths,
  result: IssueRunResult,
): Promise<void> {
  try {
    const journal = await readJournal(paths);
    const plan = await loadTaskPlan(paths.tasksFile).catch(() => null);

    const assessment = assessDecomposition({
      journal,
      plan,
      filesTouched: await countChangedFiles(),
      hitMaxIterations: result.failedPhase === 'execute' && plan?.issueStatus !== 'completed',
    });
    if (!assessment.oversized) return;

    const report = buildDecompositionReport({
      issueNumber,
      assessment,
      plan,
      at: isoNow(),
    });
    const reportFile = paths.decompositionFile;
    await mkdir(paths.issueDir, { recursive: true });
    await writeFile(reportFile, report, 'utf-8');

    printWarning(`Issue #${issueNumber} looks larger than one run. Report: ${reportFile}`);
    for (const signal of assessment.signals) {
      printWarning(`  ${signal.detail}`);
    }

    await maybeCreateSubIssues(issueNumber, plan, reportFile);

    if (plan !== null) {
      await saveTaskPlan(paths.tasksFile, {
        ...plan,
        runState: {
          currentPhase: plan.runState?.currentPhase ?? result.failedPhase,
          attempt: plan.runState?.attempt ?? 0,
          owner: null,
          status: 'blocked',
          blockedReason: `Looks larger than one run; see ${reportFile}`,
          lastHeartbeatAt: isoNow(),
        },
      });
    }
  } catch {
    // A report is a courtesy. Failing to write one must not change the exit
    // code of a run that already failed for its own reasons.
  }
}

async function readJournal(paths: IssuePaths): Promise<string> {
  const repository = getPlanRepository(paths.tasksFile);
  if (repository === undefined) return '';
  const events = await listStoredIssueEvents({
    projectId: repository.projectId,
    issueId: repository.issueId,
    ...(repository.databaseOptions === undefined
      ? {}
      : { databaseOptions: repository.databaseOptions }),
  });
  return events.map((entry) => JSON.stringify(entry)).join('\n');
}

/**
 * Create the proposed sub-issues, but only when asked and only when it is safe.
 *
 * Two conditions, and the second is the one that matters: `--auto-decompose`
 * has to be on, **and** the branch must carry no committed story yet. Splitting
 * an issue whose work is half done leaves commits that belong to no issue and
 * sub-issues that describe work already merged — a mess nobody asked for, made
 * automatically at 3am. With commits present the report still stands; only the
 * acting stops.
 */
export async function maybeCreateSubIssues(
  issueNumber: string,
  plan: TaskPlan | null,
  reportFile: string,
): Promise<void> {
  if (getActiveResilienceConfig().decompose?.auto !== true) {
    printInfo(`Nothing was split. Read ${reportFile} and decide.`);
    return;
  }

  const committed = await committedStoryIds(await getBaseBranch()).catch(() => new Set<string>());
  if (committed.size > 0) {
    printWarning(
      `--auto-decompose did not run: ${committed.size} story(ies) are already committed on this branch. ` +
        'Splitting on top of committed work needs a person.',
    );
    return;
  }

  const proposals = proposeSubIssues(plan);
  if (proposals.length === 0) {
    printInfo('Nothing left to split: no pending story.');
    return;
  }

  const { runGenerate } = await import('../generate.js');
  for (const proposal of proposals) {
    const instruction = [
      `Create a sub-issue of #${issueNumber}: ${proposal.title}.`,
      proposal.dependsOn.length === 0 ? '' : `It depends on: ${proposal.dependsOn.join(', ')}.`,
      'It covers exactly these user stories, and nothing else:',
      ...proposal.stories.map((story) => `- ${story.id} ${story.title}: ${story.description}`),
    ]
      .filter((line) => line !== '')
      .join('\n');

    const code = await runGenerate(instruction);
    if (code !== 0) {
      printWarning(
        `Could not create "${proposal.title}". The report at ${reportFile} still stands.`,
      );
      return;
    }
  }
}

/** Files changed on this branch, or `0` when git cannot say. */
export async function countChangedFiles(): Promise<number> {
  try {
    const base = await getBaseBranch();
    const result = await run('git', ['diff', '--name-only', `${base}...HEAD`]);
    if (result.exitCode !== 0) return 0;
    return result.stdout.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}
