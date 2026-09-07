import { getStoredIssueHistory } from '../storage/db/queries.js';
import { resolveProjectPaths } from '../storage/resolve.js';
import { printError, printInfo } from '../ui/logger.js';

export interface HistoryOptions {
  json?: boolean;
}

export async function runHistory(issueId: string, options: HistoryOptions = {}): Promise<number> {
  try {
    const project = await resolveProjectPaths();
    const history = await getStoredIssueHistory({ projectId: project.projectId, issueId });

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
