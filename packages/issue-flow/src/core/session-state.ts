import { mkdir, rename, utimes, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { setTelemetrySessionId } from '../telemetry/session-id.js';
import type { StoryStage, UserStory } from '../types.js';
import {
  DEFAULT_LOG_LIMIT,
  DEFAULT_SESSION_HEARTBEAT_MS,
  DEFAULT_THROTTLE_MS,
  type SessionEvent,
  type SessionLogLevel,
} from './session/events.js';
import {
  accumulate,
  accumulateUsage,
  computePercent,
  deriveNextSteps,
  deriveStoryStatuses,
  estimateRemainingSeconds,
  reported,
  secondsBetween,
} from './session/derive.js';
import {
  createInitialSnapshot,
  emptyPhaseTiming,
  emptyUsage,
  type SessionLogEntry,
  type SessionProcessLogEntry,
  type SessionReducerOptions,
  type SessionSnapshot,
  type SessionStorySnapshot,
} from './session/snapshot.js';

export type {
  SessionLogLevel,
  SessionStatus,
  SessionPhaseStatus,
  SessionEvent,
} from './session/events.js';
export {
  DEFAULT_LOG_LIMIT,
  DEFAULT_THROTTLE_MS,
  DEFAULT_SESSION_HEARTBEAT_MS,
} from './session/events.js';
export type {
  SessionEnvironment,
  SessionLogEntry,
  SessionProcessLogEntry,
  SessionConfigurationValue,
  SessionPhaseConfiguration,
  SessionConfigurationSnapshot,
  SessionStageHistoryEntry,
  SessionUsageSnapshot,
  SessionMetricsSnapshot,
  SessionPhaseSnapshot,
  SessionStorySnapshot,
  SessionActivity,
  SessionResilienceSnapshot,
  SessionCommit,
  SessionPullRequest,
  SessionIssueSnapshot,
  SessionRepositorySnapshot,
  SessionSnapshot,
  SessionReducerOptions,
} from './session/snapshot.js';
export { createInitialSnapshot } from './session/snapshot.js';

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

function transitionStory(
  story: SessionStorySnapshot,
  stage: StoryStage,
  at: string,
  detail: string | null,
): SessionStorySnapshot {
  if (story.stage === stage && story.stageDetail === detail) return story;
  return {
    ...story,
    stage,
    stageSince: at,
    stageDetail: detail,
    history: [...story.history, { at, stage, detail }],
  };
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
      setTelemetrySessionId(event.sessionId);
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
          ...emptyPhaseTiming(),
          ...emptyUsage(),
        })),
        git: {
          branch: event.branch ?? null,
          baseBranch: event.baseBranch ?? null,
          branchCreated: event.branchCreated ?? null,
          startCommit: event.startCommit ?? null,
          commits: [],
        },
        // The branch is the one piece of repository identity the session
        // already knows here; the rest waits for publishGitState. Seeding it
        // keeps git.branch and repository.branch consistent for a poll that
        // lands before the first git:update.
        repository: { ...initial.repository, branch: event.branch ?? null },
        configuration: event.configuration ?? null,
        environment: event.environment
          ? {
              node: event.environment.node,
              platform: event.environment.platform,
              agent: event.environment.agent ?? null,
              model: event.environment.model ?? null,
              cliVersion: event.environment.cliVersion ?? null,
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
              ...emptyPhaseTiming(),
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
              story.passes ? transitionStory(story, 'in_review', event.at, null) : story,
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
              harnessExecutionMs: event.harnessExecutionMs ?? p.harnessExecutionMs,
              orchestrationOverheadMs: event.orchestrationOverheadMs ?? p.orchestrationOverheadMs,
              harnessStartupMs: event.harnessStartupMs ?? p.harnessStartupMs,
              ttftMs: event.ttftMs ?? p.ttftMs,
              attemptCount: event.attemptCount ?? p.attemptCount,
              retryDurationMs: event.retryDurationMs ?? p.retryDurationMs,
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
            isTerminalStage(story.stage) ? story : transitionStory(story, 'failed', event.at, null),
          )
        : event.phase === 'review'
          ? snapshot.stories.map((story) =>
              story.passes ? transitionStory(story, 'done', event.at, null) : story,
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
          return transitionStory(story, 'executing', event.at, null);
        }
        return transitionStory(story, 'pending', event.at, null);
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

    case 'agent:attempt':
      return {
        ...snapshot,
        resilience: {
          ...snapshot.resilience,
          attempt: event.attempt,
          provider: event.provider,
          model: event.model ?? null,
          lastActivityAt: event.at,
        },
      };

    case 'failover':
      return {
        ...snapshot,
        resilience: {
          ...snapshot.resilience,
          provider: event.to,
          lastFailureKind: event.reason,
          cooldownUntil: event.cooldownUntil ?? null,
          lastActivityAt: event.at,
        },
      };

    case 'agent:result':
      return {
        ...snapshot,
        resilience: {
          ...snapshot.resilience,
          provider: event.provider,
          lastFailureKind: event.failureKind ?? snapshot.resilience.lastFailureKind,
          cooldownUntil: event.cooldownUntil ?? null,
          lastActivityAt: event.at,
        },
      };

    case 'agent:activity':
      return {
        ...snapshot,
        resilience: {
          ...snapshot.resilience,
          provider: event.provider,
          lastActivityAt: event.at,
        },
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
        const stage = deriveStageOnStoriesUpdate(story, before, event.at);
        const history = before?.history ?? [];
        const stageChanged = before !== undefined && before.stage !== stage.stage;
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
          ...stage,
          history: stageChanged
            ? [...history, { at: event.at, stage: stage.stage, detail: stage.stageDetail }]
            : history,
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
      return {
        ...snapshot,
        currentActivity: { story, tool, detail, since },
        resilience: { ...snapshot.resilience, lastActivityAt: event.at },
      };
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

    case 'process:output': {
      const limit = options?.logLimit ?? DEFAULT_LOG_LIMIT;
      const entry: SessionProcessLogEntry = {
        at: event.at,
        phase: event.phase,
        executionId: event.executionId,
        provider: event.provider,
        stream: event.stream,
        message: stripVTControlCharacters(event.message),
      };
      return {
        ...snapshot,
        processLogs: [...snapshot.processLogs, entry].slice(-Math.max(1, limit)),
      };
    }

    case 'execution:update': {
      const index = snapshot.executions.findIndex((entry) => entry.id === event.execution.id);
      const executions = [...snapshot.executions];
      if (index === -1) executions.push(event.execution);
      else executions[index] = event.execution;
      return { ...snapshot, executions };
    }

    case 'git:update':
      return {
        ...snapshot,
        git: {
          branch: event.branch ?? snapshot.git.branch,
          baseBranch: event.baseBranch ?? snapshot.git.baseBranch,
          branchCreated: reported(event.branchCreated, snapshot.git.branchCreated),
          startCommit: snapshot.git.startCommit,
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
        story.passes ? transitionStory(story, 'in_correction', event.at, stageDetail) : story,
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

    case 'verify:end':
      return {
        ...snapshot,
        verification: {
          verdict: event.verdict,
          level: event.level,
          independence: event.independence,
        },
      };

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
          return transitionStory(story, stage, event.at, null);
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
    const terminal =
      event.type === 'phase:end' || event.type === 'session:end' || event.type === 'verify:end';
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
