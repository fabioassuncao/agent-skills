import { readFile } from 'node:fs/promises';
import { parseJournal } from '../core/journal.js';
import { loadTaskPlan } from '../core/state-manager.js';
import { getStoredIssueHistory, type StoredIssueHistory } from '../storage/db/queries.js';
import { resolveIssuePaths, resolveProjectPaths } from '../storage/resolve.js';
import { printError, printInfo } from '../ui/logger.js';

export interface HistoryOptions {
  json?: boolean;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function jsonHistory(issueId: string): Promise<StoredIssueHistory> {
  const paths = await resolveIssuePaths(issueId);
  const plan = await loadTaskPlan(paths.tasksFile);
  const content = `${await readFile(paths.rotatedEventsFile, 'utf-8').catch(() => '')}${await readFile(paths.eventsFile, 'utf-8').catch(() => '')}`;
  const phases = parseJournal(content)
    .filter(({ event }) => event.type === 'phase:start' || event.type === 'phase:end')
    .map(({ event }) => event as unknown as Record<string, unknown>);
  const evidence = await readJson(paths.verifyFile);
  return {
    issueId,
    runs: [],
    phases,
    executions: plan.executions ?? [],
    verifications: evidence === null ? [] : [evidence],
    reviews:
      plan.prReview === undefined ? [] : [plan.prReview as unknown as Record<string, unknown>],
  };
}

export async function runHistory(issueId: string, options: HistoryOptions = {}): Promise<number> {
  try {
    const project = await resolveProjectPaths();
    const history =
      project.storageDriver === 'sqlite'
        ? await getStoredIssueHistory({ projectId: project.projectId, issueId })
        : await jsonHistory(issueId);

    if (options.json === true) {
      printInfo(JSON.stringify({ schemaVersion: 1, ...history }, null, 2));
      return 0;
    }

    printInfo(`History for issue #${issueId}`);
    for (const run of history.runs) {
      printInfo(
        `run ${String(run.id)} · ${String(run.status)} · ${String(run.started_at)}${run.finished_at == null ? '' : ` → ${String(run.finished_at)}`}`,
      );
    }
    for (const phase of history.phases) {
      printInfo(
        `phase ${String(phase.name ?? phase.phase)} · ${String(phase.status ?? (phase.success === false ? 'failed' : 'completed'))}`,
      );
    }
    for (const execution of history.executions) {
      printInfo(
        `execution ${execution.purpose} · attempt ${execution.attempt} · ${execution.trigger} · ${execution.status} · ${execution.agent.harness}`,
      );
    }
    for (const verification of history.verifications) {
      printInfo(
        `verification · ${String(verification.verdict ?? verification.status ?? 'unknown')}`,
      );
    }
    for (const review of history.reviews) {
      printInfo(
        `review · ${String(review.lastRecommendation ?? review.recommendation ?? review.status ?? 'unknown')}`,
      );
    }
    if (
      history.runs.length +
        history.phases.length +
        history.executions.length +
        history.verifications.length +
        history.reviews.length ===
      0
    ) {
      printInfo('No history recorded yet.');
    }
    return 0;
  } catch (error) {
    printError(
      `Could not read history for issue #${issueId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
