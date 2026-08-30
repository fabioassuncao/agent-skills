import { mkdir, rename, utimes, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { FailureKind } from '../resilience/errors.js';
import type { StoryStage, UserStory, UserStoryStatus } from '../types.js';

/**
 * Session state publishing layer for the optional web monitoring mode.
 *
 * Instrumentation points call publish() with SessionEvents; a pure reducer
 * folds each event into an in-memory SessionSnapshot that any surface
 * (file, HTTP endpoint, future webhooks) can consume in a single format.
 *
 * Monitoring must never affect the pipeline: publish() is synchronous and
 * never throws, and all publisher I/O failures are swallowed after a
 * single warning.
 */

export type SessionLogLevel = 'info' | 'warn' | 'error';
export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed';
export type SessionPhaseStatus = 'pending' | 'running' | 'completed' | 'failed';

/** Default max entries retained in the logs ring buffer. */
export const DEFAULT_LOG_LIMIT = 200;

/** Default minimum interval between FilePublisher disk writes. */
export const DEFAULT_THROTTLE_MS = 1000;

/** Default interval for touching a live session file without rewriting it. */
export const DEFAULT_SESSION_HEARTBEAT_MS = 10_000;

export type SessionEvent =
  | {
      type: 'session:start';
      at: string;
      sessionId: string;
      /** `null` for local identifiers that are not numbers. */
      issueNumber: number | null;
      issueUrl?: string;
      branch?: string;
      baseBranch?: string;
      phases: string[];
      environment?: SessionEnvironment;
    }
  | {
      /**
       * Structural data of the Issue being worked on, published once the
       * provider has resolved it. Merged over the `issue` section instead of
       * replacing it, so the number and the URL that came with `session:start`
       * survive an origin that reports neither.
       */
      type: 'issue:update';
      at: string;
      number: number | null;
      url?: string;
      title: string | null;
      /** Issue body, published whole — no truncation. */
      description: string | null;
      labels: string[];
      state: string | null;
    }
  | { type: 'phase:start'; at: string; phase: string }
  | { type: 'phase:end'; at: string; phase: string; success: boolean; error?: string }
  | {
      type: 'iteration:start';
      at: string;
      iteration: number;
      /**
       * Id of the story `execute` is about to work on, computed by
       * `core/engine.ts` with the same "highest priority, `passes: false`"
       * rule `prompts/execute.md` gives the agent. Optional so a caller that
       * cannot determine it (or an older build) is still a valid event —
       * `applyEvent` simply skips the `executing`/`pending` transition then.
       */
      storyId?: string;
    }
  | { type: 'iteration:end'; at: string; iteration: number }
  | {
      type: 'retry';
      at: string;
      attempt: number;
      delaySeconds?: number;
      reason?: string;
      /**
       * What the resilience layer classified the failure as. Optional so an
       * event written by an older build — or by a caller with nothing but a
       * message — stays valid; the reducer only counts retries either way.
       */
      kind?: FailureKind;
    }
  | {
      type: 'agent:attempt';
      at: string;
      attempt: number;
      provider: string;
      model?: string | null;
      primaryProvider: string;
    }
  | {
      type: 'failover';
      at: string;
      from: string;
      to: string;
      reason: FailureKind | null;
      cooldownUntil?: string | null;
    }
  | {
      type: 'agent:result';
      at: string;
      provider: string;
      success: boolean;
      failureKind?: FailureKind;
      cooldownUntil?: string | null;
    }
  | { type: 'stories:update'; at: string; stories: UserStory[] }
  | { type: 'activity'; at: string; story?: string; tool?: string; detail?: string }
  | { type: 'log'; at: string; level: SessionLogLevel; message: string }
  | { type: 'correction:cycle'; at: string; cycle: number; maxCycles: number }
  | {
      type: 'metrics:update';
      at: string;
      /**
       * Where the metrics land:
       * - `phase`: the named phase plus the issue-wide aggregate;
       * - `iteration`: one execute-loop pass — same targets as `phase`;
       * - `story`: the story alone, never the phase nor the aggregate (the
       *   iteration event of the same cycle already counted those tokens).
       */
      scope: 'phase' | 'iteration' | 'story';
      phase?: string;
      storyId?: string;
      iteration?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      costUsd?: number;
      durationSeconds?: number;
    }
  | {
      /**
       * One publication feeds both the `git` section (branch, base, commits)
       * and the `repository` section (identity and location). They come from
       * the same collection pass, so extending this event keeps `branch`
       * consistent across the two instead of racing a second event.
       *
       * Every field is optional: `undefined` means "not collected in this
       * publication" and leaves the snapshot untouched, while an explicit
       * `null` means "collected and unavailable" and is written as-is.
       */
      type: 'git:update';
      at: string;
      branch?: string;
      baseBranch?: string;
      commits?: SessionCommit[];
      pullRequests?: SessionPullRequest[];
      /** `owner/repo`, derived from the origin remote. */
      repositoryName?: string | null;
      remoteUrl?: string | null;
      headCommit?: string | null;
      repositoryRoot?: string | null;
    }
  | { type: 'session:end'; at: string; status: 'completed' | 'failed'; error?: string };

export interface SessionEnvironment {
  node: string;
  platform: string;
  /** Winning agent provider for the run. `null` on snapshots from earlier releases. */
  agent: string | null;
  /** Winning model for the run. `null` when unset or on older snapshots. */
  model: string | null;
}

export interface SessionLogEntry {
  at: string;
  level: SessionLogLevel;
  message: string;
}

/**
 * Token/cost counters attached to a phase or a story.
 *
 * `null` means "never reported" — the `claude` CLI does not always return
 * usage data, and a metric that was never observed must stay distinguishable
 * from an observed zero.
 */
export interface SessionUsageSnapshot {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
}

/** Issue-wide totals, accumulated from phase- and iteration-scoped metrics. */
export interface SessionMetricsSnapshot {
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCacheReadTokens: number | null;
  totalCacheCreationTokens: number | null;
  totalCostUsd: number | null;
}

export interface SessionPhaseSnapshot extends SessionUsageSnapshot {
  name: string;
  status: SessionPhaseStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  error: string | null;
}

export interface SessionStorySnapshot extends SessionUsageSnapshot {
  id: string;
  title: string;
  priority: number;
  passes: boolean;
  /**
   * When the story flipped to passing during this session; null for stories
   * that were already passing at session start (their duration is unknown).
   */
  completedAt: string | null;
  /** Wall-clock seconds attributed to the story, or null when unknown. */
  durationSeconds: number | null;
  /**
   * Board-style status, recomputed on every reduction by
   * {@link deriveStoryStatus}. Observational: the pipeline keeps deciding what
   * to execute from `passes`.
   */
  status: UserStoryStatus;
  /** IDs of the stories this one depends on, as declared in the plan. */
  dependencies: string[];
  /** The plan's description; empty string when the plan carries none. */
  description: string;
  /** The plan's acceptance criteria; empty when the plan carries none. */
  acceptanceCriteria: string[];
  /**
   * Fine-grained execution stage, derived only from real pipeline events —
   * see {@link StoryStage} and the `applyEvent` cases for `iteration:start`,
   * `stories:update`, `phase:start`/`phase:end` (phase `'review'`) and
   * `correction:cycle`. Unlike `status`, this is not a post-hoc derivation
   * recomputed on every reduction: it is set directly, event by event, like
   * `completedAt`.
   */
  stage: StoryStage;
  /** ISO timestamp of the event that produced the current `stage`. */
  stageSince: string | null;
  /** Short human detail for the current stage (e.g. a correction cycle). */
  stageDetail: string | null;
}

export interface SessionActivity {
  story: string | null;
  tool: string | null;
  detail: string | null;
  since: string;
}

export interface SessionCommit {
  hash: string;
  subject: string;
}

export interface SessionPullRequest {
  number: number;
  url: string;
  title: string;
}

/**
 * The Issue under execution, as far as the session knows it.
 *
 * `number`/`url` come with `session:start`; the remaining fields arrive with
 * `issue:update`, once the provider has resolved the Issue. Everything is
 * nullable because a run may start before (or without) that resolution —
 * `null` means "not reported", never "empty".
 */
export interface SessionIssueSnapshot {
  number: number | null;
  url: string | null;
  title: string | null;
  /** Issue body in full; the consumer decides how to fold it. */
  description: string | null;
  labels: string[];
  /** Provider lifecycle state ('open' / 'closed' for the built-ins). */
  state: string | null;
}

/**
 * Where the run is happening: which repository, which checkout, which commit.
 *
 * Fed by `git:update` (see `publishGitState`). Every field is nullable because
 * each source is independent and failure-tolerant — no remote configured, a
 * repository with no commits yet or a missing git binary all show up as
 * `null` instead of failing the publication.
 */
export interface SessionRepositorySnapshot {
  /** `owner/repo`, derived from the origin remote; null without one. */
  name: string | null;
  remoteUrl: string | null;
  branch: string | null;
  /** Abbreviated hash of HEAD. */
  headCommit: string | null;
  /** Absolute path of the working directory the pipeline runs from. */
  root: string | null;
}

export interface SessionSnapshot {
  schemaVersion: 1;
  sessionId: string | null;
  readOnly: true;
  capabilities: string[];
  issue: SessionIssueSnapshot;
  status: SessionStatus;
  startedAt: string | null;
  updatedAt: string | null;
  endedAt: string | null;
  elapsedSeconds: number | null;
  estimatedRemainingSeconds: number | null;
  progress: {
    percent: number;
    phasesCompleted: number;
    phasesTotal: number;
    storiesCompleted: number;
    storiesTotal: number;
  };
  currentPhase: string | null;
  currentActivity: SessionActivity | null;
  phases: SessionPhaseSnapshot[];
  stories: SessionStorySnapshot[];
  metrics: SessionMetricsSnapshot;
  execution: {
    iteration: number;
    retries: number;
    correctionCycle: number;
    maxCorrectionCycles: number | null;
  };
  git: { branch: string | null; baseBranch: string | null; commits: SessionCommit[] };
  repository: SessionRepositorySnapshot;
  pullRequests: SessionPullRequest[];
  logs: SessionLogEntry[];
  errors: SessionLogEntry[];
  warnings: SessionLogEntry[];
  lastError: { message: string; at: string } | null;
  nextSteps: string[];
  environment: SessionEnvironment | null;
}

export interface SessionReducerOptions {
  /** Max entries retained in the logs ring buffer. */
  logLimit?: number;
}

/** Fresh, all-null usage counters for a new phase or story entry. */
function emptyUsage(): SessionUsageSnapshot {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    costUsd: null,
  };
}

function emptyMetrics(): SessionMetricsSnapshot {
  return {
    totalInputTokens: null,
    totalOutputTokens: null,
    totalCacheReadTokens: null,
    totalCacheCreationTokens: null,
    totalCostUsd: null,
  };
}

export function createInitialSnapshot(): SessionSnapshot {
  return {
    schemaVersion: 1,
    sessionId: null,
    readOnly: true,
    capabilities: [],
    issue: { number: null, url: null, title: null, description: null, labels: [], state: null },
    status: 'idle',
    startedAt: null,
    updatedAt: null,
    endedAt: null,
    elapsedSeconds: null,
    estimatedRemainingSeconds: null,
    progress: {
      percent: 0,
      phasesCompleted: 0,
      phasesTotal: 0,
      storiesCompleted: 0,
      storiesTotal: 0,
    },
    currentPhase: null,
    currentActivity: null,
    phases: [],
    stories: [],
    metrics: emptyMetrics(),
    execution: { iteration: 0, retries: 0, correctionCycle: 0, maxCorrectionCycles: null },
    git: { branch: null, baseBranch: null, commits: [] },
    repository: { name: null, remoteUrl: null, branch: null, headCommit: null, root: null },
    pullRequests: [],
    logs: [],
    errors: [],
    warnings: [],
    lastError: null,
    nextSteps: [],
    environment: null,
  };
}

type MetricsUpdateEvent = Extract<SessionEvent, { type: 'metrics:update' }>;

/**
 * Add a reported delta to an accumulator. `undefined` means "not reported":
 * it leaves the accumulator untouched, so a metric the CLI never returned
 * stays null instead of collapsing to zero.
 */
function accumulate(current: number | null, delta: number | undefined): number | null {
  return delta === undefined ? current : (current ?? 0) + delta;
}

/** Fold the event's token/cost fields into a phase or story entry. */
function accumulateUsage<T extends SessionUsageSnapshot>(target: T, event: MetricsUpdateEvent): T {
  return {
    ...target,
    inputTokens: accumulate(target.inputTokens, event.inputTokens),
    outputTokens: accumulate(target.outputTokens, event.outputTokens),
    cacheReadTokens: accumulate(target.cacheReadTokens, event.cacheReadTokens),
    cacheCreationTokens: accumulate(target.cacheCreationTokens, event.cacheCreationTokens),
    costUsd: accumulate(target.costUsd, event.costUsd),
  };
}

/**
 * Pick between a reported value and the one already in the snapshot.
 * Unlike `??`, an explicitly reported `null` wins: only `undefined` — the
 * absence of the field on the event — keeps the previous value.
 */
function reported<T>(value: T | undefined, previous: T): T {
  return value === undefined ? previous : value;
}

/**
 * Seconds between two ISO timestamps, or null when either is unparsable.
 */
function secondsBetween(from: string | null, to: string): number | null {
  if (from === null) return null;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return null;
  return Math.max(0, Math.round((toMs - fromMs) / 1000));
}

function computePercent(phasesCompleted: number, phasesTotal: number): number {
  if (phasesTotal === 0) return 0;
  return Math.round((phasesCompleted / phasesTotal) * 100);
}

/**
 * Estimated seconds until all stories pass: average duration of the stories
 * completed during this session × pending stories. Durations are the gaps
 * between consecutive completions (the first is measured from startedAt).
 * Published as null with fewer than two samples.
 */
function estimateRemainingSeconds(snapshot: SessionSnapshot): number | null {
  const completions = snapshot.stories
    .map((story) => (story.completedAt === null ? Number.NaN : Date.parse(story.completedAt)))
    .filter((ms) => !Number.isNaN(ms))
    .sort((a, b) => a - b);
  if (completions.length < 2) return null;

  const startMs = snapshot.startedAt === null ? Number.NaN : Date.parse(snapshot.startedAt);
  const boundaries = Number.isNaN(startMs) ? completions : [startMs, ...completions];
  const durations: number[] = [];
  for (let i = 1; i < boundaries.length; i++) {
    durations.push(Math.max(0, boundaries[i] - boundaries[i - 1]));
  }
  if (durations.length === 0) return null;

  const averageMs = durations.reduce((sum, d) => sum + d, 0) / durations.length;
  const pending = snapshot.stories.filter((story) => !story.passes).length;
  return Math.round((averageMs * pending) / 1000);
}

/**
 * Remaining pipeline phases, in order. The phase list originates from the
 * session:start event, whose caller passes PIPELINE_PHASES (or
 * PIPELINE_PHASES_NO_BRANCH in --no-branch mode) from src/core/pipeline.ts.
 */
function deriveNextSteps(snapshot: SessionSnapshot): string[] {
  if (snapshot.status === 'completed') return [];
  return snapshot.phases.filter((phase) => phase.status === 'pending').map((phase) => phase.name);
}

/**
 * Board status of a single story, in a fixed order that makes the derivation
 * idempotent — recomputing it over its own result yields the same value:
 *
 * 1. `passes: true` → `done` (execution is the only authority on completion);
 * 2. already `in_review` → kept, since nothing here can produce or clear it;
 * 3. the story owns the current activity → `in_progress`;
 * 4. otherwise → `backlog`.
 *
 * `in_review` is therefore never derived: it only enters through an explicit
 * `status` in tasks.json, and leaves when the story starts passing.
 */
function deriveStoryStatus(
  story: SessionStorySnapshot,
  activeStory: string | null,
): UserStoryStatus {
  if (story.passes) return 'done';
  if (story.status === 'in_review') return 'in_review';
  if (activeStory !== null && activeStory === story.id) return 'in_progress';
  return 'backlog';
}

/** Recompute every story's status; entries that do not change keep identity. */
function deriveStoryStatuses(snapshot: SessionSnapshot): SessionStorySnapshot[] {
  const activeStory = snapshot.currentActivity?.story ?? null;
  return snapshot.stories.map((story) => {
    const status = deriveStoryStatus(story, activeStory);
    return status === story.status ? story : { ...story, status };
  });
}

/**
 * Fold a SessionEvent into a SessionSnapshot. Pure: never mutates the input
 * and performs no I/O. Unknown event types return the snapshot unchanged.
 *
 * errors/warnings are derived slices of the logs ring buffer, recomputed on
 * each reduction — they are never accumulated separately. The same applies
 * to estimatedRemainingSeconds, nextSteps and each story's status.
 */
export function reduceSessionEvent(
  snapshot: SessionSnapshot,
  event: SessionEvent,
  options?: SessionReducerOptions,
): SessionSnapshot {
  const next = applyEvent(snapshot, event, options);
  if (next === snapshot) return snapshot;

  const elapsedSeconds = secondsBetween(next.startedAt, event.at) ?? next.elapsedSeconds;
  return {
    ...next,
    updatedAt: event.at,
    elapsedSeconds,
    stories: deriveStoryStatuses(next),
    estimatedRemainingSeconds: estimateRemainingSeconds(next),
    errors: next.logs.filter((entry) => entry.level === 'error'),
    warnings: next.logs.filter((entry) => entry.level === 'warn'),
    nextSteps: deriveNextSteps(next),
  };
}

/**
 * Stages that describe a finished story. A run that ends — successfully or
 * not — must never leave a story on any other stage, or the panel keeps
 * claiming it is executing long after the process is gone.
 */
function isTerminalStage(stage: StoryStage): boolean {
  return stage === 'done' || stage === 'failed';
}

/**
 * `stage`/`stageSince`/`stageDetail` for one story, on one `stories:update`.
 *
 * This event owns exactly one transition — `awaiting_review` the moment a
 * story flips to `passes: true` (or is first seen already passing, since its
 * real completion moment is unknown either way). Everything else is a
 * carry-over: a still-`passes: false` story keeps whatever `iteration:start`
 * last gave it (defaulting to `'pending'` the very first time it is ever
 * seen), and a story already passing before this event is left exactly as it
 * was — `phase:start`/`phase:end` (review) and `correction:cycle` own every
 * transition past `awaiting_review`.
 */
function deriveStageOnStoriesUpdate(
  story: UserStory,
  before: SessionStorySnapshot | undefined,
  at: string,
): Pick<SessionStorySnapshot, 'stage' | 'stageSince' | 'stageDetail'> {
  if (!story.passes) {
    return {
      stage: before?.stage ?? 'pending',
      stageSince: before?.stageSince ?? at,
      stageDetail: before?.stageDetail ?? null,
    };
  }
  if (before?.passes) {
    return { stage: before.stage, stageSince: before.stageSince, stageDetail: before.stageDetail };
  }
  return { stage: 'awaiting_review', stageSince: at, stageDetail: null };
}

function applyEvent(
  snapshot: SessionSnapshot,
  event: SessionEvent,
  options?: SessionReducerOptions,
): SessionSnapshot {
  switch (event.type) {
    case 'session:start': {
      const initial = createInitialSnapshot();
      return {
        ...initial,
        sessionId: event.sessionId,
        issue: { ...initial.issue, number: event.issueNumber, url: event.issueUrl ?? null },
        status: 'running',
        startedAt: event.at,
        progress: {
          ...initial.progress,
          phasesTotal: event.phases.length,
        },
        phases: event.phases.map((name) => ({
          name,
          status: 'pending' as const,
          startedAt: null,
          endedAt: null,
          durationSeconds: null,
          error: null,
          ...emptyUsage(),
        })),
        git: { branch: event.branch ?? null, baseBranch: event.baseBranch ?? null, commits: [] },
        // The branch is the one piece of repository identity the session
        // already knows here; the rest waits for publishGitState. Seeding it
        // keeps git.branch and repository.branch consistent for a poll that
        // lands before the first git:update.
        repository: { ...initial.repository, branch: event.branch ?? null },
        environment: event.environment
          ? {
              node: event.environment.node,
              platform: event.environment.platform,
              agent: event.environment.agent ?? null,
              model: event.environment.model ?? null,
            }
          : null,
      };
    }

    case 'issue:update':
      return {
        ...snapshot,
        issue: {
          ...snapshot.issue,
          // Merge, not replacement: the run may know a number and a URL that
          // the provider does not report (a local Issue mirroring a remote
          // one), and enriching the section must never erase them.
          number: event.number ?? snapshot.issue.number,
          url: event.url ?? snapshot.issue.url,
          title: event.title,
          description: event.description,
          labels: event.labels,
          state: event.state,
        },
      };

    case 'phase:start': {
      const known = snapshot.phases.some((p) => p.name === event.phase);
      const phases = known
        ? snapshot.phases.map((p) =>
            p.name === event.phase
              ? {
                  ...p,
                  status: 'running' as const,
                  startedAt: event.at,
                  endedAt: null,
                  error: null,
                }
              : p,
          )
        : [
            ...snapshot.phases,
            {
              name: event.phase,
              status: 'running' as const,
              startedAt: event.at,
              endedAt: null,
              durationSeconds: null,
              error: null,
              ...emptyUsage(),
            },
          ];
      // The `execute` phase only completes (and `review` only starts) once
      // every story already passes — a pipeline invariant — so entering
      // `review` safely moves every passing story to 'in_review' in one go;
      // there is never a not-yet-passing story to skip over here.
      const stories =
        event.phase === 'review'
          ? snapshot.stories.map((story) =>
              story.passes
                ? { ...story, stage: 'in_review' as const, stageSince: event.at, stageDetail: null }
                : story,
            )
          : snapshot.stories;
      return {
        ...snapshot,
        currentPhase: event.phase,
        phases,
        stories,
        progress: known ? snapshot.progress : { ...snapshot.progress, phasesTotal: phases.length },
      };
    }

    case 'phase:end': {
      const phases = snapshot.phases.map((p) =>
        p.name === event.phase
          ? {
              ...p,
              status: event.success ? ('completed' as const) : ('failed' as const),
              endedAt: event.at,
              durationSeconds: secondsBetween(p.startedAt, event.at),
              error: event.error ? stripVTControlCharacters(event.error) : null,
            }
          : p,
      );
      const phasesCompleted = phases.filter((p) => p.status === 'completed').length;
      // Success moves every passing story to 'done'. Failure (the correction
      // loop gave up after maxCorrectionCycles) closes every story that is not
      // already 'done' as 'failed' — including the ones that never reached
      // `passes`, which are precisely the stories the issue calls failed. A
      // phase that fails outside `review` closes the same non-terminal stages,
      // so nothing is left frozen on 'executing' after the run stops.
      const stories = !event.success
        ? snapshot.stories.map((story) =>
            isTerminalStage(story.stage)
              ? story
              : { ...story, stage: 'failed' as const, stageSince: event.at, stageDetail: null },
          )
        : event.phase === 'review'
          ? snapshot.stories.map((story) =>
              story.passes
                ? { ...story, stage: 'done' as const, stageSince: event.at, stageDetail: null }
                : story,
            )
          : snapshot.stories;
      return {
        ...snapshot,
        currentPhase: snapshot.currentPhase === event.phase ? null : snapshot.currentPhase,
        currentActivity: null,
        phases,
        stories,
        progress: {
          ...snapshot.progress,
          phasesCompleted,
          percent: computePercent(phasesCompleted, snapshot.progress.phasesTotal),
        },
      };
    }

    case 'iteration:start': {
      // The story matching storyId becomes 'executing'; every other
      // not-yet-passing story becomes 'pending' (a story that was already
      // 'executing' in a previous iteration but lost the turn reverts here).
      // Passing stories are untouched — this event owns only the
      // execute-loop's own pending/executing transition, never review or
      // correction. No-op branches (`return story`) avoid needless object
      // churn when the stage is already correct.
      const storyId = event.storyId;
      const stories = snapshot.stories.map((story) => {
        if (story.passes) return story;
        if (story.id === storyId) {
          return story.stage === 'executing'
            ? story
            : { ...story, stage: 'executing' as const, stageSince: event.at, stageDetail: null };
        }
        return story.stage === 'pending'
          ? story
          : { ...story, stage: 'pending' as const, stageSince: event.at, stageDetail: null };
      });
      return {
        ...snapshot,
        execution: { ...snapshot.execution, iteration: event.iteration },
        stories,
        // Finally populates the `story` field of the activity payload during
        // execute — today this phase never publishes an `activity` event at
        // all (no streaming), so `currentActivity` stays whatever an earlier
        // phase left it at. Left untouched when storyId is absent (every
        // story already passes, or the caller could not determine one).
        currentActivity:
          storyId !== undefined
            ? { story: storyId, tool: null, detail: null, since: event.at }
            : snapshot.currentActivity,
      };
    }

    case 'iteration:end':
      return { ...snapshot, currentActivity: null };

    case 'retry':
      return {
        ...snapshot,
        execution: { ...snapshot.execution, retries: snapshot.execution.retries + 1 },
      };

    case 'stories:update': {
      const previous = new Map(snapshot.stories.map((story) => [story.id, story]));
      const stories = event.stories.map((story) => {
        const before = previous.get(story.id);
        // Stamp the flip to passing; stories already passing when first seen
        // keep null (completed before this session, duration unknown).
        const completedAt = !story.passes
          ? null
          : before && !before.passes
            ? event.at
            : (before?.completedAt ?? null);
        // stories:update rebuilds the array from the plan on every publish, so
        // metrics already attributed to a story must be carried over here or
        // the next update would wipe them.
        return {
          id: story.id,
          title: story.title,
          priority: story.priority,
          passes: story.passes,
          completedAt,
          // Seed only: deriveStoryStatus() recomputes it right after, so an
          // explicit 'done' in the plan on a story with passes: false is not
          // honoured — `passes` remains the single source of truth. The plan's
          // value survives just for 'in_review', which no derivation produces.
          status: story.status ?? before?.status ?? 'backlog',
          dependencies: story.dependencies ?? [],
          // Required on UserStory, so the plan is always the source — no
          // carry-over from `before` the way the accumulated fields need.
          description: story.description,
          acceptanceCriteria: story.acceptanceCriteria,
          durationSeconds: before?.durationSeconds ?? null,
          inputTokens: before?.inputTokens ?? null,
          outputTokens: before?.outputTokens ?? null,
          cacheReadTokens: before?.cacheReadTokens ?? null,
          cacheCreationTokens: before?.cacheCreationTokens ?? null,
          costUsd: before?.costUsd ?? null,
          ...deriveStageOnStoriesUpdate(story, before, event.at),
        };
      });
      return {
        ...snapshot,
        stories,
        progress: {
          ...snapshot.progress,
          storiesCompleted: stories.filter((s) => s.passes).length,
          storiesTotal: stories.length,
        },
      };
    }

    case 'activity': {
      const story = event.story ?? null;
      const tool = event.tool ?? null;
      const detail = event.detail ?? null;
      const current = snapshot.currentActivity;
      // Same activity repeated: keep `since` so the UI can show "for how long".
      const since =
        current && current.story === story && current.tool === tool && current.detail === detail
          ? current.since
          : event.at;
      return { ...snapshot, currentActivity: { story, tool, detail, since } };
    }

    case 'log': {
      const limit = options?.logLimit ?? DEFAULT_LOG_LIMIT;
      const entry: SessionLogEntry = {
        at: event.at,
        level: event.level,
        message: stripVTControlCharacters(event.message),
      };
      const logs = [...snapshot.logs, entry].slice(-Math.max(1, limit));
      return { ...snapshot, logs };
    }

    case 'git:update':
      return {
        ...snapshot,
        git: {
          branch: event.branch ?? snapshot.git.branch,
          baseBranch: event.baseBranch ?? snapshot.git.baseBranch,
          commits: event.commits ?? snapshot.git.commits,
        },
        repository: {
          // `undefined` is "not collected", so the previous value stands; an
          // explicit `null` is "collected and unavailable" and overwrites it.
          name: reported(event.repositoryName, snapshot.repository.name),
          remoteUrl: reported(event.remoteUrl, snapshot.repository.remoteUrl),
          branch: event.branch ?? snapshot.repository.branch,
          headCommit: reported(event.headCommit, snapshot.repository.headCommit),
          root: reported(event.repositoryRoot, snapshot.repository.root),
        },
        pullRequests: event.pullRequests ?? snapshot.pullRequests,
      };

    case 'correction:cycle': {
      // Correction is pipeline-wide, not per-story: commands/run.ts re-runs
      // the whole execute+review cycle on a review failure, with no notion
      // of which story a finding belongs to — so every passing story moves
      // to 'in_correction' together, carrying the cycle count as a readable
      // stageDetail.
      const stageDetail = `Cycle ${event.cycle}/${event.maxCycles}`;
      const stories = snapshot.stories.map((story) =>
        story.passes
          ? { ...story, stage: 'in_correction' as const, stageSince: event.at, stageDetail }
          : story,
      );
      return {
        ...snapshot,
        execution: {
          ...snapshot.execution,
          correctionCycle: event.cycle,
          maxCorrectionCycles: event.maxCycles,
        },
        stories,
      };
    }

    case 'metrics:update': {
      if (event.scope === 'story') {
        // Story metrics are a rateio of the iteration that completed them;
        // the iteration-scoped event already fed the phase and the aggregate,
        // so counting them again here would double the totals.
        if (event.storyId === undefined) return snapshot;
        if (!snapshot.stories.some((s) => s.id === event.storyId)) return snapshot;
        return {
          ...snapshot,
          stories: snapshot.stories.map((story) =>
            story.id === event.storyId
              ? {
                  ...accumulateUsage(story, event),
                  durationSeconds: accumulate(story.durationSeconds, event.durationSeconds),
                }
              : story,
          ),
        };
      }

      // phase and iteration scopes both land on the named phase. An event for
      // a phase the snapshot never saw is ignored rather than appended: it
      // would show up as a phantom entry in the UI.
      if (event.phase === undefined) return snapshot;
      if (!snapshot.phases.some((p) => p.name === event.phase)) return snapshot;
      return {
        ...snapshot,
        // durationSeconds is deliberately untouched here: phase:start and
        // phase:end remain the single source of a phase's wall-clock time.
        phases: snapshot.phases.map((phase) =>
          phase.name === event.phase ? accumulateUsage(phase, event) : phase,
        ),
        metrics: {
          totalInputTokens: accumulate(snapshot.metrics.totalInputTokens, event.inputTokens),
          totalOutputTokens: accumulate(snapshot.metrics.totalOutputTokens, event.outputTokens),
          totalCacheReadTokens: accumulate(
            snapshot.metrics.totalCacheReadTokens,
            event.cacheReadTokens,
          ),
          totalCacheCreationTokens: accumulate(
            snapshot.metrics.totalCacheCreationTokens,
            event.cacheCreationTokens,
          ),
          totalCostUsd: accumulate(snapshot.metrics.totalCostUsd, event.costUsd),
        },
      };
    }

    case 'session:end':
      return {
        ...snapshot,
        status: event.status,
        endedAt: event.at,
        currentPhase: null,
        currentActivity: null,
        // Close every non-terminal stage: the run is over, so nothing can be
        // 'executing'/'in_review'/'in_correction' any more. A story that never
        // reached `passes` on a run that did not complete is exactly what the
        // 'failed' stage means; anything else settles as 'done'.
        stories: snapshot.stories.map((story) => {
          if (isTerminalStage(story.stage)) return story;
          const stage =
            event.status === 'completed' && story.passes ? ('done' as const) : ('failed' as const);
          return { ...story, stage, stageSince: event.at, stageDetail: null };
        }),
        lastError: event.error
          ? { message: stripVTControlCharacters(event.error), at: event.at }
          : snapshot.lastError,
      };

    default:
      return snapshot;
  }
}

export interface SessionPublisher {
  /**
   * Publish an event. Synchronous, never throws, never returns a promise —
   * safe to call from any instrumentation point without affecting execution.
   */
  publish(event: SessionEvent): void;
  /** Current in-memory snapshot. */
  snapshot(): SessionSnapshot;
  /** Monotonic counter, bumped on every applied event (basis for ETags). */
  version(): number;
  /** Force any pending output to be written. Never rejects. */
  flush(): Promise<void>;
  /** Flush and release resources. Never rejects. */
  close(): Promise<void>;
}

/**
 * Default publisher when monitoring is off: every call is a no-op, so each
 * instrumentation point costs a method call that returns immediately.
 */
export class NullPublisher implements SessionPublisher {
  private readonly empty = createInitialSnapshot();

  publish(_event: SessionEvent): void {}

  snapshot(): SessionSnapshot {
    return this.empty;
  }

  version(): number {
    return 0;
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}
}

export interface MemoryPublisherOptions extends SessionReducerOptions {
  /** Called at most once, on the first internal failure. */
  onWarn?: (message: string) => void;
  /**
   * When false, log events are dropped before reaching the snapshot, so no
   * log line is ever published (session.json or HTTP). Default true.
   */
  includeLogs?: boolean;
}

/**
 * In-memory publisher: reduces events over a snapshot and tracks a monotonic
 * version. Base class for publishers with an output surface (file, HTTP).
 */
export class MemoryPublisher implements SessionPublisher {
  protected state: SessionSnapshot = createInitialSnapshot();
  protected versionCounter = 0;
  private warned = false;
  private readonly onWarn: (message: string) => void;
  private readonly reducerOptions: SessionReducerOptions;
  private readonly includeLogs: boolean;

  constructor(options: MemoryPublisherOptions = {}) {
    this.onWarn = options.onWarn ?? ((message) => process.stderr.write(`${message}\n`));
    this.reducerOptions = { logLimit: options.logLimit };
    this.includeLogs = options.includeLogs ?? true;
  }

  publish(event: SessionEvent): void {
    if (event.type === 'log' && !this.includeLogs) return;
    try {
      this.state = reduceSessionEvent(this.state, event, this.reducerOptions);
      this.versionCounter++;
      this.afterPublish(event);
    } catch (err) {
      this.warnOnce(err);
    }
  }

  /** Hook for subclasses; runs inside publish()'s try/catch. */
  protected afterPublish(_event: SessionEvent): void {}

  snapshot(): SessionSnapshot {
    return this.state;
  }

  version(): number {
    return this.versionCounter;
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}

  protected warnOnce(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const message = err instanceof Error ? err.message : String(err);
    try {
      this.onWarn(
        `issue-flow: web monitoring hit an error (will keep retrying silently): ${message}`,
      );
    } catch {
      // Even a failing warn callback must not propagate to the pipeline.
    }
  }
}

export interface FilePublisherOptions extends MemoryPublisherOptions {
  /** Minimum interval between disk writes (ms). Default 1000. */
  throttleMs?: number;
  /** Interval between mtime-only heartbeats (ms). Zero disables it. Default 10000. */
  heartbeatMs?: number;
}

/**
 * Publisher that mirrors the snapshot to issues/N/session.json.
 *
 * Writes are atomic (write-to-temp + rename) and throttled; terminal events
 * (phase:end, session:end) force an immediate write. All I/O failures are
 * swallowed after a single warning.
 */
export class FilePublisher extends MemoryPublisher {
  private readonly filePath: string;
  private readonly throttleMs: number;
  private timer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastWriteStartedAt = 0;
  private lastWrittenVersion = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(filePath: string, options: FilePublisherOptions = {}) {
    super(options);
    this.filePath = filePath;
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_SESSION_HEARTBEAT_MS;
    if (heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this.enqueueHeartbeat(), heartbeatMs);
      this.heartbeatTimer.unref();
    }
  }

  protected override afterPublish(event: SessionEvent): void {
    if (this.closed) return;
    const terminal = event.type === 'phase:end' || event.type === 'session:end';
    this.scheduleWrite(terminal);
  }

  private scheduleWrite(force: boolean): void {
    if (force) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.enqueueWrite();
      return;
    }
    if (this.timer !== null) return;
    const wait = Math.max(0, this.throttleMs - (Date.now() - this.lastWriteStartedAt));
    if (wait === 0) {
      this.enqueueWrite();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueueWrite();
    }, wait);
    this.timer.unref();
  }

  private enqueueWrite(): void {
    this.lastWriteStartedAt = Date.now();
    this.writeChain = this.writeChain.then(async () => {
      const version = this.versionCounter;
      if (version === this.lastWrittenVersion) return;
      const payload = `${JSON.stringify(this.state, null, 2)}\n`;
      try {
        await atomicWriteFile(this.filePath, payload);
        this.lastWrittenVersion = version;
      } catch (err) {
        this.warnOnce(err);
      }
    });
  }

  /**
   * Keep directory-based discovery alive without changing snapshot content or
   * its content-derived ETag. The write chain serializes the touch with atomic
   * snapshot replacement, and no heartbeat is attempted before the first file
   * has been written successfully.
   */
  private enqueueHeartbeat(): void {
    if (this.closed) return;
    this.writeChain = this.writeChain.then(async () => {
      if (this.closed || this.lastWrittenVersion === 0) return;
      const now = new Date();
      try {
        await utimes(this.filePath, now, now);
      } catch (err) {
        this.warnOnce(err);
      }
    });
  }

  override async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.versionCounter !== this.lastWrittenVersion) {
      this.enqueueWrite();
    }
    await this.writeChain;
  }

  override async close(): Promise<void> {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.closed = true;
    await this.flush();
  }
}

/**
 * Atomic write: write to a temp file next to the target, then rename. The
 * same-directory temp keeps the rename on a single filesystem (rename is
 * atomic; no EXDEV fallback needed, unlike an os.tmpdir() temp on Linux
 * tmpfs) and leaves nothing behind. The FilePublisher write chain is the
 * single writer, so the fixed .tmp name never races.
 *
 * The target directory (issues/N/) may not exist yet the first time a fresh
 * issue publishes — pipeline phases create it lazily, and this can be the
 * very first write. mkdir recursive is idempotent, so it's cheap to ensure
 * on every write rather than relying on call order elsewhere.
 */
async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpFile = `${path}.tmp`;
  await writeFile(tmpFile, content, 'utf-8');
  await rename(tmpFile, path);
}
