import type {
  SessionPhaseSnapshot,
  SessionSnapshot,
  SessionStorySnapshot,
} from '../core/session-state.js';
import { formatDuration, getIcons, type Icons } from './logger.js';
import { stripMarkdown } from './text.js';

export interface StatusViewOptions {
  /** Override icons (tests, or a caller that already resolved them). */
  icons?: Icons;
  /** Monitor URL, shown only when a web surface is actually up. */
  monitorUrl?: string | null;
}

/**
 * Pure projection of a `SessionSnapshot` into the clean terminal view.
 *
 * No I/O: the same function is what the renderer paints and what the tests
 * assert. The terminal does not compute a second, parallel view of the run.
 */
export function renderStatusView(
  snapshot: SessionSnapshot,
  options: StatusViewOptions = {},
): string[] {
  const icons = options.icons ?? getIcons();
  const lines: string[] = [];

  const issue = formatIssueHeadline(snapshot);
  lines.push(issue);

  const location = formatLocationLine(snapshot, options.monitorUrl);
  if (location !== null) lines.push(location);

  lines.push('');

  for (const phase of snapshot.phases) {
    lines.push(formatPhaseLine(phase, snapshot, icons));
  }

  const focus = renderExecuteFocus(snapshot, { icons });
  if (focus.length > 0) {
    lines.push('');
    lines.push(...focus);
  }

  const footer = formatFooter(snapshot);
  if (footer !== null) {
    lines.push('');
    lines.push(`  ${footer}`);
  }

  return lines;
}

/**
 * The live execute focus: active story plus current tool activity.
 *
 * Clean mode shows these two lines instead of one subtask per story.
 */
export function renderExecuteFocus(
  snapshot: SessionSnapshot,
  options: StatusViewOptions = {},
): string[] {
  const icons = options.icons ?? getIcons();
  const story = activeStory(snapshot);
  if (story === undefined && snapshot.currentActivity === null) return [];

  const lines: string[] = [];
  if (story !== undefined) {
    const duration =
      story.durationSeconds !== null && story.durationSeconds !== undefined
        ? `  ${formatDuration(story.durationSeconds)}`
        : '';
    lines.push(`  ${icons.pending} ${story.id}  ${stripMarkdown(story.title)}${duration}`);
  }

  const activity = snapshot.currentActivity;
  if (activity?.tool) {
    const detail = activity.detail ? `  ${stripMarkdown(activity.detail)}` : '';
    lines.push(`     ${activity.tool}${detail}`);
  }
  return lines;
}

export function formatIssueHeadline(snapshot: SessionSnapshot): string {
  const number = snapshot.issue.number !== null ? `#${snapshot.issue.number}` : null;
  const title = snapshot.issue.title ? stripMarkdown(snapshot.issue.title) : null;
  const bits = ['Issue Flow', number, title].filter((bit): bit is string => bit !== null);
  return bits.join(' · ');
}

function formatLocationLine(
  snapshot: SessionSnapshot,
  monitorUrl: string | null | undefined,
): string | null {
  const bits: string[] = [];
  if (snapshot.git.branch) bits.push(snapshot.git.branch);
  if (monitorUrl) bits.push(`monitor ${monitorUrl}`);
  return bits.length > 0 ? bits.join(' · ') : null;
}

function formatPhaseLine(
  phase: SessionPhaseSnapshot,
  snapshot: SessionSnapshot,
  icons: Icons,
): string {
  const icon = phaseIcon(phase.status, icons);
  const label = phaseLabel(phase.name);
  const detail = phaseDetail(phase, snapshot);
  const duration =
    phase.durationSeconds !== null && phase.durationSeconds !== undefined
      ? formatDuration(phase.durationSeconds)
      : '';
  const body = detail === '' ? label : `${label}     ${detail}`;
  return duration === '' ? `  ${icon} ${body}` : `  ${icon} ${body}  ${duration}`;
}

function phaseIcon(status: SessionPhaseSnapshot['status'], icons: Icons): string {
  switch (status) {
    case 'completed':
      return icons.success;
    case 'failed':
      return icons.fail;
    case 'running':
      return icons.pending;
    default:
      return icons.notReached;
  }
}

function phaseLabel(name: string): string {
  if (name === 'prd') return 'PRD';
  if (name === 'pr-review') return 'PR Review';
  if (name === 'init') return 'Preflight';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function phaseDetail(phase: SessionPhaseSnapshot, snapshot: SessionSnapshot): string {
  if (phase.name !== 'execute') {
    if (phase.status === 'failed' && phase.error) return stripMarkdown(phase.error);
    return '';
  }
  const bits: string[] = [];
  const { storiesCompleted, storiesTotal } = snapshot.progress;
  if (storiesTotal > 0) bits.push(`${storiesCompleted}/${storiesTotal} stories`);
  if (snapshot.execution.iteration > 0) bits.push(`iteration ${snapshot.execution.iteration}`);
  if (snapshot.execution.retries > 0) bits.push(`${snapshot.execution.retries} retries`);
  return bits.join(' · ');
}

function formatFooter(snapshot: SessionSnapshot): string | null {
  const bits: string[] = [];
  if (snapshot.elapsedSeconds !== null) {
    bits.push(`elapsed ${formatDuration(snapshot.elapsedSeconds)}`);
  }
  if (snapshot.estimatedRemainingSeconds !== null) {
    bits.push(`remaining ~${formatDuration(snapshot.estimatedRemainingSeconds)}`);
  }
  if (snapshot.metrics.totalCostUsd !== null) {
    bits.push(`$${snapshot.metrics.totalCostUsd.toFixed(2)}`);
  }
  if (snapshot.execution.retries > 0) {
    bits.push(`${snapshot.execution.retries} retries`);
  }
  if (snapshot.verification?.verdict === 'unverified') {
    bits.push('unverified');
  } else if (snapshot.verification?.verdict === 'failed') {
    bits.push('contract failed');
  }
  return bits.length > 0 ? bits.join(' · ') : null;
}

function activeStory(snapshot: SessionSnapshot): SessionStorySnapshot | undefined {
  const fromActivity = snapshot.currentActivity?.story;
  if (fromActivity) {
    const match = snapshot.stories.find((story) => story.id === fromActivity);
    if (match) return match;
  }
  return snapshot.stories.find((story) => story.stage === 'executing');
}
