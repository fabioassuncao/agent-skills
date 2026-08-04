import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrReviewRecommendation } from '../../types.js';
import { writeFileAtomic } from '../../utils/fs.js';
import {
  type PrReviewFinding,
  type PrReviewIndex,
  type PrReviewPullRequest,
  readPrReviewIndex,
  reportFileName,
  upsertRound,
} from './report.js';

/**
 * Where the outcome of a review round goes.
 *
 * The phase itself only knows this interface, so pointing the results at
 * GitHub later (a review comment, a check run) is a new implementation and a
 * configuration change — not a change to the phase.
 */

/** One finished review round, ready to be published. */
export interface PrReviewReport {
  pullRequest: PrReviewPullRequest;
  round: number;
  at: string;
  headSha: string | null;
  /** null when the agent output could not be parsed. */
  recommendation: PrReviewRecommendation | null;
  blockers: string[];
  findings: PrReviewFinding[];
  /** The full Markdown report, already assembled by `buildReportMarkdown()`. */
  markdown: string;
}

export interface PrReviewPublisher {
  publish(report: PrReviewReport): Promise<void>;
}

/**
 * Writes `pr-<N>-round-<k>.md` plus `index.json` under the artifact directory.
 *
 * Rounds are additive: an existing index is loaded and merged instead of being
 * replaced, so round N+1 never erases the trail of the rounds before it. Both
 * files go through `writeFileAtomic()`, the mechanism `saveTaskPlan()` uses —
 * an interrupted write leaves the previous artifacts intact rather than a
 * truncated report.
 *
 * This publisher never writes to GitHub.
 */
export class LocalReportPublisher implements PrReviewPublisher {
  constructor(private readonly dir: string) {}

  async publish(report: PrReviewReport): Promise<void> {
    await mkdir(this.dir, { recursive: true });

    const fileName = reportFileName(report.pullRequest.number, report.round);
    await writeFileAtomic(join(this.dir, fileName), report.markdown);

    const existing = await readPrReviewIndex(this.dir);
    const index: PrReviewIndex = {
      schemaVersion: 1,
      pullRequest: report.pullRequest,
      rounds: existing?.rounds ?? [],
    };

    const updated = upsertRound(index, {
      round: report.round,
      at: report.at,
      recommendation: report.recommendation,
      headSha: report.headSha,
      reportPath: fileName,
      findings: report.findings,
    });

    await writeFileAtomic(join(this.dir, 'index.json'), `${JSON.stringify(updated, null, 2)}\n`);
  }
}
