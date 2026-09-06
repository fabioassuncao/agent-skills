import { metric } from './format';
import {
  type ExecutionStatusKey,
  isExecutionStatus,
  isVerificationVerdict,
  STORY_STAGE_LABELS,
  STORY_STATUS_LABELS,
  type StoryStageKey,
  type StoryStatusKey,
  type VerificationVerdict,
} from './vocabulary';

/**
 * Reading a snapshot that may have been written by any past release.
 *
 * The contract types `/api/status` as `Record<string, unknown>` and says why:
 * `sessionSnapshotSchema` in `packages/issue-flow/src/schemas.ts` is its
 * authority, the pipeline versions it, and a monitor that refused to render a
 * snapshot it could not fully parse would be strictly worse than one that
 * renders what it recognises. So the narrowing happens here, field by field.
 *
 * **This is the U18 guard, and it is the trap the current panel documents.**
 * `undefined` (the release that wrote the file did not have the field) is not
 * `null` (the field exists and was not reported) is not `0` (a legitimate
 * value). The first two both mean "not reported" and neither may ever reach the
 * screen as `0` or `NaN`. Every numeric read below goes through `metric()`, and
 * every list and string read has an explicit shape check — `!value` is never
 * the test, because zero and the empty string are answers.
 */

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A string, or `null` for anything that is not one — including `''`. */
export function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function stringList(value: unknown): string[] {
  return list(value).filter((entry): entry is string => typeof entry === 'string');
}

export function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export interface SnapshotUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
}

export interface SnapshotIssue {
  number: number | null;
  url: string | null;
  title: string | null;
  description: string | null;
  labels: string[];
  state: string | null;
}

export interface SnapshotPhase extends SnapshotUsage {
  name: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  error: string | null;
}

export interface SnapshotStory extends SnapshotUsage {
  id: string;
  title: string;
  passes: boolean;
  completedAt: string | null;
  durationSeconds: number | null;
  status: StoryStatusKey;
  stage: StoryStageKey;
  stageSince: string | null;
  stageDetail: string | null;
  dependencies: string[];
  description: string;
  acceptanceCriteria: string[];
  history: { at: string | null; stage: string; detail: string | null }[];
}

export interface SnapshotCommit {
  hash: string;
  subject: string;
  committedAt: string | null;
  storyId: string | null;
}

export interface SnapshotPullRequest {
  number: number | null;
  url: string | null;
  title: string;
}

export interface SnapshotLogEntry {
  at: string | null;
  level: string;
  message: string;
}

export interface SnapshotProcessLog {
  at: string | null;
  phase: string;
  executionId: string | null;
  message: string;
}

export interface SnapshotExecution {
  id: string;
  purpose: string;
  attempt: number | null;
  trigger: string;
  status: string;
  storyIds: string[];
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  correctionCycle: number | null;
  usage: SnapshotUsage;
  cost: { status: string | null; amount: number | null; reason: string | null };
  agent: { harness: string | null; model: string | null };
  verdict: string | null;
  failure: string | null;
}

export interface SnapshotConfigurationValue {
  value: string | null;
  source: string | null;
}

export interface SnapshotConfiguration {
  defaultProvider: SnapshotConfigurationValue;
  defaultModel: SnapshotConfigurationValue;
  fallbacks: string[];
  precedence: string[];
  phases: {
    phase: string;
    provider: SnapshotConfigurationValue;
    model: SnapshotConfigurationValue;
  }[];
}

export interface ExecutionSnapshot {
  sessionId: string | null;
  readOnly: boolean;
  issue: SnapshotIssue;
  status: ExecutionStatusKey;
  startedAt: string | null;
  updatedAt: string | null;
  endedAt: string | null;
  elapsedSeconds: number | null;
  estimatedRemainingSeconds: number | null;
  progress: {
    percent: number;
    phasesCompleted: number | null;
    phasesTotal: number | null;
    storiesCompleted: number | null;
    storiesTotal: number | null;
  };
  currentPhase: string | null;
  currentActivity: {
    story: string | null;
    tool: string | null;
    detail: string | null;
    since: string | null;
  } | null;
  phases: SnapshotPhase[];
  stories: SnapshotStory[];
  metrics: {
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
    totalCacheReadTokens: number | null;
    totalCacheCreationTokens: number | null;
    totalCostUsd: number | null;
  };
  executions: SnapshotExecution[];
  processLogs: SnapshotProcessLog[];
  configuration: SnapshotConfiguration | null;
  resilience: {
    attempt: number | null;
    provider: string | null;
    model: string | null;
    lastFailureKind: string | null;
    cooldownUntil: string | null;
    lastActivityAt: string | null;
  };
  git: {
    branch: string | null;
    baseBranch: string | null;
    branchCreated: boolean | null;
    commits: SnapshotCommit[];
  };
  repository: {
    name: string | null;
    branch: string | null;
    headCommit: string | null;
    root: string | null;
  };
  pullRequests: SnapshotPullRequest[];
  logs: SnapshotLogEntry[];
  errors: SnapshotLogEntry[];
  warnings: SnapshotLogEntry[];
  lastError: { message: string; at: string | null } | null;
  nextSteps: string[];
  environment: {
    node: string | null;
    platform: string | null;
    agent: string | null;
    model: string | null;
    cliVersion: string | null;
  } | null;
  agent: {
    lifecycle: string | null;
    since: string | null;
    phase: string | null;
    awaitingInputCount: number | null;
    awaitingInputEscalatedAt: string | null;
    awaitingInputWaitedMs: number | null;
    humanHold: { since: string | null; reason: string | null } | null;
  };
  /**
   * `null` means no acceptance contract has run. That is a different statement
   * from `unverified`, which means one ran and could not conclude (U21).
   */
  verification: {
    verdict: VerificationVerdict | null;
    level: string | null;
    independence: string | null;
  } | null;
}

function readUsage(source: Record<string, unknown>): SnapshotUsage {
  return {
    inputTokens: metric(source.inputTokens),
    outputTokens: metric(source.outputTokens),
    cacheReadTokens: metric(source.cacheReadTokens),
    cacheCreationTokens: metric(source.cacheCreationTokens),
    costUsd: metric(source.costUsd),
  };
}

function readPhase(raw: unknown): SnapshotPhase {
  const source = record(raw);
  return {
    ...readUsage(source),
    name: text(source.name),
    status: text(source.status) || 'pending',
    startedAt: optionalText(source.startedAt),
    endedAt: optionalText(source.endedAt),
    durationSeconds: metric(source.durationSeconds),
    error: optionalText(source.error),
  };
}

/**
 * Normalise a story once, here, so no consumer repeats the absence checks.
 *
 * `status` and `stage` fall back **inside the closed vocabulary**: a value the
 * panel does not know reads as `backlog`/`pending` rather than reaching a badge
 * as a raw identifier.
 */
export function normalizeStory(raw: unknown): SnapshotStory {
  const source = record(raw);
  const status = text(source.status);
  const stage = text(source.stage);
  return {
    ...readUsage(source),
    id: text(source.id),
    title: text(source.title),
    passes: source.passes === true,
    completedAt: optionalText(source.completedAt),
    durationSeconds: metric(source.durationSeconds),
    status: status in STORY_STATUS_LABELS ? (status as StoryStatusKey) : 'backlog',
    stage: stage in STORY_STAGE_LABELS ? (stage as StoryStageKey) : 'pending',
    stageSince: optionalText(source.stageSince),
    stageDetail: optionalText(source.stageDetail),
    dependencies: stringList(source.dependencies),
    description: text(source.description),
    acceptanceCriteria: stringList(source.acceptanceCriteria),
    history: list(source.history).map((entry) => {
      const item = record(entry);
      return {
        at: optionalText(item.at),
        stage: text(item.stage),
        detail: optionalText(item.detail),
      };
    }),
  };
}

function readConfigurationValue(raw: unknown): SnapshotConfigurationValue {
  const source = record(raw);
  return { value: optionalText(source.value), source: optionalText(source.source) };
}

function readConfiguration(raw: unknown): SnapshotConfiguration | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  return {
    defaultProvider: readConfigurationValue(source.defaultProvider),
    defaultModel: readConfigurationValue(source.defaultModel),
    fallbacks: stringList(source.fallbacks),
    precedence: stringList(source.precedence),
    phases: list(source.phases).map((entry) => {
      const phase = record(entry);
      return {
        phase: text(phase.phase),
        provider: readConfigurationValue(phase.provider),
        model: readConfigurationValue(phase.model),
      };
    }),
  };
}

function readExecution(raw: unknown): SnapshotExecution {
  const source = record(raw);
  const cost = record(source.cost);
  const agent = record(source.agent);
  const model = record(agent.model);
  const failure = record(source.failure);
  const verdict = record(source.verdict);
  return {
    id: text(source.id),
    purpose: text(source.purpose),
    attempt: metric(source.attempt),
    trigger: text(source.trigger),
    status: text(source.status),
    storyIds: stringList(source.storyIds),
    startedAt: optionalText(source.startedAt),
    finishedAt: optionalText(source.finishedAt),
    durationMs: metric(source.durationMs),
    correctionCycle: metric(source.correctionCycle),
    usage: readUsage(record(source.usage)),
    cost: {
      status: optionalText(cost.status),
      amount: metric(cost.amount),
      reason: optionalText(cost.reason),
    },
    agent: {
      harness: optionalText(agent.harness),
      model: optionalText(model.resolved) ?? optionalText(model.requested),
    },
    verdict: optionalText(verdict.status),
    failure: optionalText(failure.message),
  };
}

function readLogEntry(raw: unknown): SnapshotLogEntry {
  const source = record(raw);
  return {
    at: optionalText(source.at),
    level: text(source.level) || 'info',
    message: text(source.message),
  };
}

function readVerification(raw: unknown): ExecutionSnapshot['verification'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  return {
    // A verdict the panel does not recognise is **not** rendered as a pass.
    // U21 makes the absence of a conclusion a verdict of its own, and guessing
    // in its place is the exact failure the rule forbids.
    verdict: isVerificationVerdict(source.verdict) ? source.verdict : null,
    level: optionalText(source.level),
    independence: optionalText(source.independence),
  };
}

/** Narrow a raw `/api/status` body into something the panel can render. */
export function readSnapshot(raw: unknown): ExecutionSnapshot {
  const source = record(raw);
  const issue = record(source.issue);
  const progress = record(source.progress);
  const activity = record(source.currentActivity);
  const metrics = record(source.metrics);
  const resilience = record(source.resilience);
  const git = record(source.git);
  const repository = record(source.repository);
  const environment = source.environment;
  const agent = record(source.agent);
  const humanHold = agent.humanHold;
  const lastError = source.lastError;

  const percent = metric(progress.percent);

  return {
    sessionId: optionalText(source.sessionId),
    readOnly: source.readOnly !== false,
    issue: {
      number: metric(issue.number),
      url: optionalText(issue.url),
      title: optionalText(issue.title),
      description: optionalText(issue.description),
      labels: stringList(issue.labels),
      state: optionalText(issue.state),
    },
    status: isExecutionStatus(source.status) ? source.status : 'idle',
    startedAt: optionalText(source.startedAt),
    updatedAt: optionalText(source.updatedAt),
    endedAt: optionalText(source.endedAt),
    elapsedSeconds: metric(source.elapsedSeconds),
    estimatedRemainingSeconds: metric(source.estimatedRemainingSeconds),
    progress: {
      // The one number with a defined floor: a progress bar has to render
      // something, and 0 % is the honest answer for "nothing reported yet".
      percent: percent === null ? 0 : Math.max(0, Math.min(100, percent)),
      phasesCompleted: metric(progress.phasesCompleted),
      phasesTotal: metric(progress.phasesTotal),
      storiesCompleted: metric(progress.storiesCompleted),
      storiesTotal: metric(progress.storiesTotal),
    },
    currentPhase: optionalText(source.currentPhase),
    currentActivity:
      typeof source.currentActivity === 'object' && source.currentActivity !== null
        ? {
            story: optionalText(activity.story),
            tool: optionalText(activity.tool),
            detail: optionalText(activity.detail),
            since: optionalText(activity.since),
          }
        : null,
    phases: list(source.phases).map(readPhase),
    stories: list(source.stories).map(normalizeStory),
    metrics: {
      totalInputTokens: metric(metrics.totalInputTokens),
      totalOutputTokens: metric(metrics.totalOutputTokens),
      totalCacheReadTokens: metric(metrics.totalCacheReadTokens),
      totalCacheCreationTokens: metric(metrics.totalCacheCreationTokens),
      totalCostUsd: metric(metrics.totalCostUsd),
    },
    executions: list(source.executions).map(readExecution),
    processLogs: list(source.processLogs).map((entry) => {
      const item = record(entry);
      return {
        at: optionalText(item.at),
        phase: text(item.phase),
        executionId: optionalText(item.executionId),
        message: text(item.message),
      };
    }),
    configuration: readConfiguration(source.configuration),
    resilience: {
      attempt: metric(resilience.attempt),
      provider: optionalText(resilience.provider),
      model: optionalText(resilience.model),
      lastFailureKind: optionalText(resilience.lastFailureKind),
      cooldownUntil: optionalText(resilience.cooldownUntil),
      lastActivityAt: optionalText(resilience.lastActivityAt),
    },
    git: {
      branch: optionalText(git.branch),
      baseBranch: optionalText(git.baseBranch),
      branchCreated: optionalBoolean(git.branchCreated),
      commits: list(git.commits).map((entry) => {
        const commit = record(entry);
        return {
          hash: text(commit.hash),
          subject: text(commit.subject),
          committedAt: optionalText(commit.committedAt),
          storyId: optionalText(commit.storyId),
        };
      }),
    },
    repository: {
      name: optionalText(repository.name),
      branch: optionalText(repository.branch),
      headCommit: optionalText(repository.headCommit),
      root: optionalText(repository.root),
    },
    pullRequests: list(source.pullRequests).map((entry) => {
      const pr = record(entry);
      return {
        number: metric(pr.number),
        url: optionalText(pr.url),
        title: text(pr.title),
      };
    }),
    logs: list(source.logs).map(readLogEntry),
    // `errors`/`warnings` are derived slices the reducer recomputes, but an
    // older file may not carry them; deriving them here keeps the alert card
    // truthful either way.
    errors:
      list(source.errors).length > 0
        ? list(source.errors).map(readLogEntry)
        : list(source.logs)
            .map(readLogEntry)
            .filter((entry) => entry.level === 'error'),
    warnings:
      list(source.warnings).length > 0
        ? list(source.warnings).map(readLogEntry)
        : list(source.logs)
            .map(readLogEntry)
            .filter((entry) => entry.level === 'warn'),
    lastError:
      typeof lastError === 'object' && lastError !== null
        ? {
            message: text((lastError as Record<string, unknown>).message),
            at: optionalText((lastError as Record<string, unknown>).at),
          }
        : null,
    nextSteps: stringList(source.nextSteps),
    environment:
      typeof environment === 'object' && environment !== null
        ? {
            node: optionalText((environment as Record<string, unknown>).node),
            platform: optionalText((environment as Record<string, unknown>).platform),
            agent: optionalText((environment as Record<string, unknown>).agent),
            model: optionalText((environment as Record<string, unknown>).model),
            cliVersion: optionalText((environment as Record<string, unknown>).cliVersion),
          }
        : null,
    agent: {
      lifecycle: optionalText(agent.lifecycle),
      since: optionalText(agent.since),
      phase: optionalText(agent.phase),
      awaitingInputCount: metric(agent.awaitingInputCount),
      awaitingInputEscalatedAt: optionalText(agent.awaitingInputEscalatedAt),
      awaitingInputWaitedMs: metric(agent.awaitingInputWaitedMs),
      humanHold:
        typeof humanHold === 'object' && humanHold !== null
          ? {
              since: optionalText((humanHold as Record<string, unknown>).since),
              reason: optionalText((humanHold as Record<string, unknown>).reason),
            }
          : null,
    },
    verification: readVerification(source.verification),
  };
}

/**
 * The single point of access to one story.
 *
 * The Kanban and the drawer never sweep `snapshot.stories` themselves — when a
 * write layer exists, this is where reading starts talking to it without the
 * UI changing.
 */
export function getStoryById(snapshot: ExecutionSnapshot | null, id: string): SnapshotStory | null {
  if (snapshot === null) return null;
  return snapshot.stories.find((story) => story.id === id) ?? null;
}

/** Invocations attached to a phase (by purpose) or to a story (by id). */
export function executionsFor(
  snapshot: ExecutionSnapshot,
  kind: 'phase' | 'story',
  id: string,
): SnapshotExecution[] {
  return snapshot.executions.filter((execution) =>
    kind === 'phase' ? execution.purpose === id : execution.storyIds.includes(id),
  );
}
