import type { TaskPlan, UserStory } from '../types.js';
import { parseJournal } from './journal.js';

/**
 * "This issue is too large" — detected, reported, and left to a person.
 *
 * A phase that keeps timing out, a plan with thirty stories, five iterations in
 * a row that finish nothing: each of those is ambiguous on its own, and any one
 * of them can also be a slow afternoon. Together they are the same thing said
 * three ways, and what they are saying is that the demand was never one issue.
 *
 * The tool's job here stops at saying so. **Splitting an issue is a product
 * decision**, and the default is a report plus `blocked`, not an act — which is
 * also why a failure that is merely *infrastructural* must never reach this
 * code path: an issue whose run died because the network went down is not too
 * large, and breaking it up would be the worst possible response.
 */

/** The thresholds, in one place, because every one of them is a judgement. */
export const DECOMPOSITION_THRESHOLDS = {
  /** Timeouts on the same phase. Two is already a pattern, not bad luck. */
  timeoutsPerPhase: 2,
  /** Stories in the plan. Past this, the plan is a backlog. */
  stories: 15,
  /** Iterations in a row that completed no story. */
  barrenIterations: 5,
  /** Files touched on the branch. */
  filesTouched: 40,
  /** Characters in the issue body. */
  issueBodyChars: 20_000,
} as const;

/** How many signals have to agree before the report is written. */
export const DECOMPOSITION_MIN_SIGNALS = 2;

export interface DecompositionInput {
  /** Contents of `events.jsonl` (both generations), oldest first. */
  journal?: string;
  plan?: TaskPlan | null;
  /** Body of the issue as the provider resolved it. */
  issueBody?: string;
  /** Files changed on the branch, from `git diff --name-only`. */
  filesTouched?: number;
  /** Whether the execute loop stopped because it ran out of iterations. */
  hitMaxIterations?: boolean;
}

export interface DecompositionSignal {
  id: string;
  /** One line a person can act on, naming the number that crossed the line. */
  detail: string;
}

export interface DecompositionAssessment {
  signals: DecompositionSignal[];
  /** Two or more signals agreeing. */
  oversized: boolean;
}

/* ── the signals ────────────────────────────────────────────────────────── */

/** Timeouts per phase, read off the journal. */
function timeoutsByPhase(journal: string): Map<string, number> {
  const counts = new Map<string, number>();
  let phase = '(unknown)';

  for (const { event } of parseJournal(journal)) {
    if (event.type === 'phase:start') {
      phase = event.phase;
      continue;
    }
    if (event.type !== 'retry') continue;
    const kind = (event as { kind?: string }).kind;
    const reason = (event as { reason?: string }).reason ?? '';
    const timedOut = kind === 'timeout' || kind === 'stalled' || /timed out|stalled/i.test(reason);
    if (!timedOut) continue;
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }
  return counts;
}

/**
 * The longest run of iterations that completed no story.
 *
 * An iteration that finishes nothing is not a failure — the agent may be
 * halfway through a story — but five of them in a row means the unit of work is
 * bigger than the loop was designed for.
 */
function longestBarrenRun(journal: string): number {
  let passing = 0;
  let current = 0;
  let longest = 0;

  for (const { event } of parseJournal(journal)) {
    if (event.type === 'iteration:start') {
      current++;
      longest = Math.max(longest, current);
      continue;
    }
    if (event.type !== 'stories:update') continue;
    const nowPassing = event.stories.filter((story) => story.passes).length;
    if (nowPassing > passing) current = 0;
    passing = Math.max(passing, nowPassing);
  }
  return longest;
}

/**
 * Weigh the evidence.
 *
 * Every signal is a number crossing a documented line, and the report quotes
 * that number: "this is too big" is not an argument, and "the `prd` phase timed
 * out three times" is.
 */
export function assessDecomposition(input: DecompositionInput): DecompositionAssessment {
  const signals: DecompositionSignal[] = [];
  const journal = input.journal ?? '';

  for (const [phase, count] of timeoutsByPhase(journal)) {
    if (count >= DECOMPOSITION_THRESHOLDS.timeoutsPerPhase) {
      signals.push({
        id: 'repeated-timeouts',
        detail: `The '${phase}' phase timed out ${count} times (threshold: ${DECOMPOSITION_THRESHOLDS.timeoutsPerPhase}).`,
      });
    }
  }

  const stories = input.plan?.userStories.length ?? 0;
  if (stories > DECOMPOSITION_THRESHOLDS.stories) {
    signals.push({
      id: 'story-count',
      detail: `The plan has ${stories} user stories (threshold: ${DECOMPOSITION_THRESHOLDS.stories}).`,
    });
  }

  const barren = longestBarrenRun(journal);
  if (barren >= DECOMPOSITION_THRESHOLDS.barrenIterations) {
    signals.push({
      id: 'barren-iterations',
      detail: `${barren} iterations in a row completed no story (threshold: ${DECOMPOSITION_THRESHOLDS.barrenIterations}).`,
    });
  }

  const files = input.filesTouched ?? 0;
  if (files > DECOMPOSITION_THRESHOLDS.filesTouched) {
    signals.push({
      id: 'files-touched',
      detail: `${files} files were touched on this branch (threshold: ${DECOMPOSITION_THRESHOLDS.filesTouched}).`,
    });
  }

  const body = input.issueBody?.length ?? 0;
  if (body > DECOMPOSITION_THRESHOLDS.issueBodyChars) {
    signals.push({
      id: 'issue-size',
      detail: `The issue body is ${body} characters (threshold: ${DECOMPOSITION_THRESHOLDS.issueBodyChars}).`,
    });
  }

  if (input.hitMaxIterations === true) {
    signals.push({
      id: 'max-iterations',
      detail: 'The execute loop stopped because it ran out of iterations, not because it finished.',
    });
  }

  return { signals, oversized: signals.length >= DECOMPOSITION_MIN_SIGNALS };
}

/* ── the report ─────────────────────────────────────────────────────────── */

/** Stories per proposed sub-issue. Small enough to finish in one run. */
const STORIES_PER_SUBISSUE = 5;

export interface ProposedSubIssue {
  title: string;
  stories: UserStory[];
  /** Titles of the sub-issues this one has to wait for. */
  dependsOn: string[];
}

/**
 * Cut the remaining work into pieces, in priority order.
 *
 * Priority order matters twice: it is the order the execute loop already works
 * in, and it makes each piece depend only on the one before it — which is the
 * only dependency shape that can be derived without understanding the code.
 * Anything cleverer would be a guess dressed as a plan.
 */
export function proposeSubIssues(plan: TaskPlan | null | undefined): ProposedSubIssue[] {
  const pending = [...(plan?.userStories ?? [])]
    .filter((story) => !story.passes)
    .sort((a, b) => a.priority - b.priority);
  if (pending.length === 0) return [];

  const chunks: ProposedSubIssue[] = [];
  for (let index = 0; index < pending.length; index += STORIES_PER_SUBISSUE) {
    const stories = pending.slice(index, index + STORIES_PER_SUBISSUE);
    const first = stories[0];
    const last = stories[stories.length - 1];
    const range =
      first === undefined || last === undefined || first.id === last.id
        ? (first?.id ?? '')
        : `${first.id}–${last.id}`;
    chunks.push({
      title: `${plan?.description ?? 'Issue'} — part ${chunks.length + 1} (${range})`,
      stories,
      dependsOn: chunks.length === 0 ? [] : [chunks[chunks.length - 1]?.title ?? ''],
    });
  }
  return chunks;
}

export interface DecompositionReportInput {
  issueNumber: string;
  assessment: DecompositionAssessment;
  plan: TaskPlan | null | undefined;
  at: string;
}

/**
 * The report itself: what was detected, what is proposed, and what to do.
 *
 * Written for a person to disagree with. It states each signal with its number,
 * proposes a cut it can justify, and stops — the decision is not the tool's.
 */
export function buildDecompositionReport(input: DecompositionReportInput): string {
  const { issueNumber, assessment, plan, at } = input;
  const proposals = proposeSubIssues(plan);
  const lines: string[] = [];

  lines.push(`# Issue #${issueNumber} looks larger than one run`, '');
  lines.push(`Detected at ${at}.`, '');
  lines.push(
    'This is a report, not an action. Nothing has been split, and nothing will be',
    'without you asking for it.',
    '',
  );

  lines.push('## What was detected', '');
  for (const signal of assessment.signals) {
    lines.push(`- **${signal.id}** — ${signal.detail}`);
  }
  lines.push('');

  if (proposals.length === 0) {
    lines.push('## Proposed split', '');
    lines.push(
      'No pending user stories were found, so there is nothing to cut here.',
      'The signals above are about the run rather than about the plan.',
      '',
    );
    return `${lines.join('\n')}\n`;
  }

  lines.push('## Proposed split', '');
  lines.push(
    `The ${proposals.reduce((total, proposal) => total + proposal.stories.length, 0)} pending` +
      ` stories, in priority order, cut into ${proposals.length} sub-issues of at most` +
      ` ${STORIES_PER_SUBISSUE}. Each depends on the one before it, which is the only`,
    'dependency shape that can be derived from the plan alone — read it as a starting',
    'point, not as an answer.',
    '',
  );

  for (const proposal of proposals) {
    lines.push(`### ${proposal.title}`, '');
    if (proposal.dependsOn.length > 0) {
      lines.push(`Depends on: ${proposal.dependsOn.join(', ')}`, '');
    }
    for (const story of proposal.stories) {
      lines.push(`- \`${story.id}\` ${story.title}`);
    }
    lines.push('');
  }

  lines.push('## What to do next', '');
  lines.push(
    '- Adjust the cut above until it matches how you would actually split the work;',
    '- create the sub-issues (`issue-flow generate "…"`) and run them as a queue;',
    '- or decide the issue is fine as it is and re-run it — nothing here blocks that,',
    '  beyond the report you are reading.',
    '',
  );

  return `${lines.join('\n')}\n`;
}
