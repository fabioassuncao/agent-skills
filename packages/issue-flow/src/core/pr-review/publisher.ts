import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrReviewRecommendation } from '../../types.js';
import { writeFileAtomic } from '../../utils/fs.js';
import { run } from '../../utils/shell.js';
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

/**
 * The marker that makes a published review addressable.
 *
 * A review round is *republished* more often than it is first published — a
 * retry of the phase, a re-run after a correction cycle, a resume — and without
 * a way to recognise its own previous comment every one of those leaves another
 * copy on the Pull Request. The marker is per round on purpose: round 2 is a
 * different statement from round 1 and gets its own comment, while a second
 * publication of round 1 updates the one that is there.
 *
 * It is an HTML comment, so it is invisible in the rendered body and survives
 * GitHub's Markdown untouched.
 */
export function reviewCommentMarker(round: number): string {
  return `<!-- issue-flow:review:${round} -->`;
}

interface GitHubComment {
  id: number;
  body: string;
}

function parseComments(stdout: string): GitHubComment[] {
  try {
    const parsed: unknown = JSON.parse(stdout || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is GitHubComment =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === 'number' &&
        typeof (entry as { body?: unknown }).body === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Publishes the report as a comment on the Pull Request, **updating** the
 * comment of the same round instead of adding a second one.
 *
 * The sequence is: read the existing comments, look for this round's marker,
 * and either `PATCH` that comment or post a new one. A `gh` that cannot answer
 * the first question falls through to posting — the failure mode of a
 * duplicated comment is better than the failure mode of a review nobody sees —
 * and nothing here throws: a Pull Request comment is a report, and a report
 * that fails to publish must not fail the phase.
 */
export class GitHubCommentPublisher implements PrReviewPublisher {
  async publish(report: PrReviewReport): Promise<void> {
    const marker = reviewCommentMarker(report.round);
    const body = `${marker}\n${report.markdown}`;
    const pr = report.pullRequest.number;

    const listed = await run('gh', [
      'api',
      `repos/{owner}/{repo}/issues/${pr}/comments`,
      '--paginate',
    ]);

    const existing =
      listed.exitCode === 0
        ? parseComments(listed.stdout).find((comment) => comment.body.includes(marker))
        : undefined;

    if (existing !== undefined) {
      await run('gh', [
        'api',
        '--method',
        'PATCH',
        `repos/{owner}/{repo}/issues/comments/${existing.id}`,
        '-f',
        `body=${body}`,
      ]);
      return;
    }

    await run('gh', ['pr', 'comment', String(pr), '--body', body]);
  }
}

/** Runs several publishers over one report, in order. */
export class CompositePrReviewPublisher implements PrReviewPublisher {
  constructor(private readonly members: readonly PrReviewPublisher[]) {}

  async publish(report: PrReviewReport): Promise<void> {
    for (const member of this.members) {
      await member.publish(report);
    }
  }
}

/**
 * Publishers selectable by configuration.
 *
 * `github` composes rather than replaces: the local artifacts are what the
 * correction cycle and `resume` read, and a Pull Request comment is an
 * additional audience, never a substitute for them.
 */
export type PrReviewPublisherKind = 'local' | 'github';

const PUBLISHERS: Record<PrReviewPublisherKind, (dir: string) => PrReviewPublisher> = {
  local: (dir) => new LocalReportPublisher(dir),
  github: (dir) =>
    new CompositePrReviewPublisher([new LocalReportPublisher(dir), new GitHubCommentPublisher()]),
};

/**
 * The publisher the phase should use. Going through the factory is what keeps
 * the command bound to `PrReviewPublisher` alone: adding a GitHub adapter is a
 * new entry here plus a configuration key, never a change to the phase.
 */
export function createPrReviewPublisher(
  dir: string,
  kind: PrReviewPublisherKind = 'local',
): PrReviewPublisher {
  return PUBLISHERS[kind](dir);
}
