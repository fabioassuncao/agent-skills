import type { FailureKind } from '../../resilience/errors.js';
import type { ExecutionRecord } from '../../telemetry/types.js';
import type { StoryStage, UserStoryStatus } from '../../types.js';
import type {
  SessionCommit,
  SessionConfigurationSnapshot,
  SessionEnvironment,
  SessionLogLevel,
  SessionPhaseStatus,
  SessionPullRequest,
  SessionStatus,
} from './events.js';

export type {
  SessionCommit,
  SessionConfigurationSnapshot,
  SessionConfigurationValue,
  SessionEnvironment,
  SessionPhaseConfiguration,
  SessionPullRequest,
} from './events.js';

export interface SessionLogEntry {
  at: string;
  level: SessionLogLevel;
  message: string;
}

export interface SessionProcessLogEntry {
  at: string;
  phase: string;
  executionId: string | null;
  provider: string;
  stream: 'stdout' | 'stderr' | 'combined';
  message: string;
}

export interface SessionStageHistoryEntry {
  at: string;
  stage: StoryStage;
  detail: string | null;
}

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
  /** Sum of invocation walls for this phase. */
  harnessExecutionMs: number | null;
  /** Phase wall minus harnessExecutionMs, when both are known. */
  orchestrationOverheadMs: number | null;
  /** Wall clock − CLI `duration_ms`. */
  harnessStartupMs: number | null;
  /** Time to first output, when the harness reports it. */
  ttftMs: number | null;
  attemptCount: number | null;
  retryDurationMs: number | null;
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
  /** Append-only transition history retained in the snapshot for the drawer. */
  history: SessionStageHistoryEntry[];
}

export interface SessionActivity {
  story: string | null;
  tool: string | null;
  detail: string | null;
  since: string;
}

/** Live resilience state for the current agent invocation. */
export interface SessionResilienceSnapshot {
  attempt: number;
  provider: string | null;
  model: string | null;
  lastFailureKind: FailureKind | null;
  cooldownUntil: string | null;
  lastActivityAt: string | null;
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
  executions: ExecutionRecord[];
  processLogs: SessionProcessLogEntry[];
  configuration: SessionConfigurationSnapshot | null;
  resilience: SessionResilienceSnapshot;
  git: {
    branch: string | null;
    baseBranch: string | null;
    branchCreated: boolean | null;
    startCommit: string | null;
    commits: SessionCommit[];
  };
  repository: SessionRepositorySnapshot;
  pullRequests: SessionPullRequest[];
  logs: SessionLogEntry[];
  errors: SessionLogEntry[];
  warnings: SessionLogEntry[];
  lastError: { message: string; at: string } | null;
  nextSteps: string[];
  environment: SessionEnvironment | null;
  /**
   * What the agent's own hooks reported about its lifecycle (ADR-05).
   *
   * Every field starts null: a run whose harness installed no hooks, or one
   * from before this section existed, is simply "never reported" — it is never
   * inferred from output.
   */
  agent: {
    lifecycle: SessionAgentLifecycle | null;
    /** When the current lifecycle was reported. */
    since: string | null;
    /** Phase the hook reported for. */
    phase: string | null;
    /** How many times this run has blocked on a human. */
    awaitingInputCount: number;
    /**
     * When nobody answered the agent for longer than the escalation threshold
     * (§32). `null` while the agent is not waiting, while somebody is holding
     * the run, and until the threshold is actually crossed.
     *
     * The policy that sets this lives in `core/awaiting-input.ts` and runs in
     * the pipeline process, so a headless run escalates with no UI in sight
     * (ADR-03). The dashboard renders this field; it never computes it.
     */
    awaitingInputEscalatedAt: string | null;
    /** How long the agent had waited when the escalation fired. */
    awaitingInputWaitedMs: number | null;
    /**
     * A person is in control (§32). While this is set the watchdog does not
     * kill the agent and the pipeline does not advance a phase.
     */
    humanHold: { since: string; reason: 'takeover' | 'requested' } | null;
  };
  /** Acceptance-contract verdict. `null` until a contract has run. */
  verification: {
    verdict: 'passed' | 'failed' | 'unverified' | null;
    level: string | null;
    independence: string | null;
  } | null;
}

/** Lifecycle states the snapshot projects, one per hook-reported session event. */
export type SessionAgentLifecycle = 'busy' | 'awaiting-input';

export interface SessionReducerOptions {
  /** Max entries retained in the logs ring buffer. */
  logLimit?: number;
}

/** Fresh, all-null usage counters for a new phase or story entry. */
export function emptyUsage(): SessionUsageSnapshot {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    costUsd: null,
  };
}

export function emptyPhaseTiming(): Pick<
  SessionPhaseSnapshot,
  | 'harnessExecutionMs'
  | 'orchestrationOverheadMs'
  | 'harnessStartupMs'
  | 'ttftMs'
  | 'attemptCount'
  | 'retryDurationMs'
> {
  return {
    harnessExecutionMs: null,
    orchestrationOverheadMs: null,
    harnessStartupMs: null,
    ttftMs: null,
    attemptCount: null,
    retryDurationMs: null,
  };
}

export function emptyMetrics(): SessionMetricsSnapshot {
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
    executions: [],
    processLogs: [],
    configuration: null,
    resilience: {
      attempt: 0,
      provider: null,
      model: null,
      lastFailureKind: null,
      cooldownUntil: null,
      lastActivityAt: null,
    },
    git: {
      branch: null,
      baseBranch: null,
      branchCreated: null,
      startCommit: null,
      commits: [],
    },
    repository: { name: null, remoteUrl: null, branch: null, headCommit: null, root: null },
    agent: {
      lifecycle: null,
      since: null,
      phase: null,
      awaitingInputCount: 0,
      awaitingInputEscalatedAt: null,
      awaitingInputWaitedMs: null,
      humanHold: null,
    },
    pullRequests: [],
    logs: [],
    errors: [],
    warnings: [],
    lastError: null,
    nextSteps: [],
    environment: null,
    verification: null,
  };
}
