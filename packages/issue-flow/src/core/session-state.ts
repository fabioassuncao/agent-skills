import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { UserStory } from '../types.js';

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
  | { type: 'phase:start'; at: string; phase: string }
  | { type: 'phase:end'; at: string; phase: string; success: boolean; error?: string }
  | { type: 'iteration:start'; at: string; iteration: number }
  | { type: 'iteration:end'; at: string; iteration: number }
  | { type: 'retry'; at: string; attempt: number; delaySeconds?: number; reason?: string }
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
      type: 'git:update';
      at: string;
      branch?: string;
      baseBranch?: string;
      commits?: SessionCommit[];
      pullRequests?: SessionPullRequest[];
    }
  | { type: 'session:end'; at: string; status: 'completed' | 'failed'; error?: string };

export interface SessionEnvironment {
  node: string;
  platform: string;
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

export interface SessionSnapshot {
  schemaVersion: 1;
  sessionId: string | null;
  readOnly: true;
  capabilities: string[];
  issue: { number: number | null; url: string | null };
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
    issue: { number: null, url: null },
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
 * Fold a SessionEvent into a SessionSnapshot. Pure: never mutates the input
 * and performs no I/O. Unknown event types return the snapshot unchanged.
 *
 * errors/warnings are derived slices of the logs ring buffer, recomputed on
 * each reduction — they are never accumulated separately. The same applies
 * to estimatedRemainingSeconds and nextSteps.
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
    estimatedRemainingSeconds: estimateRemainingSeconds(next),
    errors: next.logs.filter((entry) => entry.level === 'error'),
    warnings: next.logs.filter((entry) => entry.level === 'warn'),
    nextSteps: deriveNextSteps(next),
  };
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
        issue: { number: event.issueNumber, url: event.issueUrl ?? null },
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
        environment: event.environment ?? null,
      };
    }

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
      return {
        ...snapshot,
        currentPhase: event.phase,
        phases,
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
      return {
        ...snapshot,
        currentPhase: snapshot.currentPhase === event.phase ? null : snapshot.currentPhase,
        currentActivity: null,
        phases,
        progress: {
          ...snapshot.progress,
          phasesCompleted,
          percent: computePercent(phasesCompleted, snapshot.progress.phasesTotal),
        },
      };
    }

    case 'iteration:start':
      return {
        ...snapshot,
        execution: { ...snapshot.execution, iteration: event.iteration },
      };

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
          durationSeconds: before?.durationSeconds ?? null,
          inputTokens: before?.inputTokens ?? null,
          outputTokens: before?.outputTokens ?? null,
          cacheReadTokens: before?.cacheReadTokens ?? null,
          cacheCreationTokens: before?.cacheCreationTokens ?? null,
          costUsd: before?.costUsd ?? null,
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
        pullRequests: event.pullRequests ?? snapshot.pullRequests,
      };

    case 'correction:cycle':
      return {
        ...snapshot,
        execution: {
          ...snapshot.execution,
          correctionCycle: event.cycle,
          maxCorrectionCycles: event.maxCycles,
        },
      };

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
  private lastWriteStartedAt = 0;
  private lastWrittenVersion = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(filePath: string, options: FilePublisherOptions = {}) {
    super(options);
    this.filePath = filePath;
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
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
    await this.flush();
    this.closed = true;
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
