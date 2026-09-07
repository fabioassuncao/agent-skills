import type { FailureKind } from '../../resilience/errors.js';
import type { ExecutionRecord } from '../../telemetry/types.js';
import type { UserStory } from '../../types.js';

/**
 * Session event contract: the union every publisher accepts and every reducer
 * folds. No imports from within `session/` — this module is the leaf of that
 * graph. The type-only imports below are package-level contracts the event
 * payload carries by identity (`UserStory`, `ExecutionRecord`, `FailureKind`).
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
      configuration?: SessionConfigurationSnapshot;
      branchCreated?: boolean | null;
      startCommit?: string | null;
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
  | {
      type: 'phase:end';
      at: string;
      phase: string;
      success: boolean;
      error?: string;
      harnessExecutionMs?: number | null;
      orchestrationOverheadMs?: number | null;
      harnessStartupMs?: number | null;
      ttftMs?: number | null;
      attemptCount?: number | null;
      retryDurationMs?: number | null;
    }
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
  | { type: 'agent:activity'; at: string; provider: string }
  | {
      /**
       * A person took over the run (§32). Reported, never inferred: the signal
       * is somebody typing into the agent's terminal, which is the whole of the
       * mechanism — there is no confirmation step and no mode to switch.
       */
      type: 'human:hold';
      at: string;
      reason: 'takeover' | 'requested';
    }
  | {
      /**
       * Control handed back, always explicitly. Nothing infers that a person is
       * done: a run that resumed itself because the terminal went quiet would
       * be the bug the hold exists to prevent, with extra steps.
       */
      type: 'human:resume';
      at: string;
    }
  | {
      /**
       * The agent's own hooks report that it started working (ADR-05). This is
       * the counterpart of `agent:awaiting-input`, and the only thing that can
       * clear it — an agent that is producing output is not blocked on anyone.
       *
       * Distinct from `agent:activity`, which is the watchdog heartbeat and
       * says only that a process wrote a byte. This one says what the harness
       * itself thinks it is doing.
       */
      type: 'agent:busy';
      at: string;
      phase: string;
    }
  | {
      /**
       * The agent is blocked on a human: a permission prompt, an elicitation
       * dialog, or a Codex permission request. It is the single most valuable
       * event absorbed from WebMux (§18), because before it the state was
       * indistinguishable from "still thinking" — including in `headless`,
       * where nobody is looking at a terminal.
       */
      type: 'agent:awaiting-input';
      at: string;
      phase: string;
    }
  | {
      /**
       * Nobody answered the agent (§32, last row of its table).
       *
       * This is **not** a human hold. A hold means somebody took the run over
       * and is thinking; this means the agent asked and *nobody came*. Reading
       * `heldForMs` for this would escalate during a legitimate takeover, which
       * is precisely what §32 forbids — so the two conditions stay apart, and
       * an escalation is suppressed while a hold exists.
       *
       * The decision is the pipeline's, never the dashboard's: a headless run
       * with no UI at all still has to escalate (ADR-03). The interface only
       * displays what this event put in the snapshot.
       */
      type: 'agent:awaiting-input-escalated';
      at: string;
      phase: string;
      /** How long the agent had been waiting when the threshold was crossed. */
      waitedMs: number;
    }
  | {
      /**
       * A pull request the agent opened by itself, seen by the `PostToolUse`
       * hook rather than reported by the `pr` phase. It folds into the same
       * `pullRequests` list the phase writes — one concept, two producers.
       */
      type: 'pr:opened';
      at: string;
      url: string;
      number: number | null;
      title?: string;
    }
  | { type: 'stories:update'; at: string; stories: UserStory[] }
  | { type: 'activity'; at: string; story?: string; tool?: string; detail?: string }
  | { type: 'log'; at: string; level: SessionLogLevel; message: string }
  | {
      type: 'process:output';
      at: string;
      phase: string;
      executionId: string | null;
      provider: string;
      stream: 'stdout' | 'stderr' | 'combined';
      message: string;
    }
  | { type: 'execution:update'; at: string; execution: ExecutionRecord }
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
      branchCreated?: boolean | null;
      commits?: SessionCommit[];
      pullRequests?: SessionPullRequest[];
      /** `owner/repo`, derived from the origin remote. */
      repositoryName?: string | null;
      remoteUrl?: string | null;
      headCommit?: string | null;
      repositoryRoot?: string | null;
    }
  | { type: 'session:end'; at: string; status: 'completed' | 'failed'; error?: string }
  | {
      type: 'verify:end';
      at: string;
      verdict: 'passed' | 'failed' | 'unverified';
      level: string;
      independence: string | null;
      executionId: string | null;
    };

export interface SessionEnvironment {
  node: string;
  platform: string;
  /** Winning agent provider for the run. `null` on snapshots from earlier releases. */
  agent: string | null;
  /** Winning model for the run. `null` when unset or on older snapshots. */
  model: string | null;
  /**
   * Version of the `issue-flow` package that produced the run. `null` on
   * snapshots written before it was recorded. It is the version of the CLI, not
   * of the monitor serving the dashboard — the two can differ, which is exactly
   * what `--restart-web` exists to fix.
   */
  cliVersion: string | null;
}

export interface SessionConfigurationValue {
  value: string | null;
  source: 'default' | 'global' | 'project' | 'env' | 'cli' | 'fallback' | 'recommended';
}

export interface SessionPhaseConfiguration {
  phase: string;
  provider: SessionConfigurationValue;
  model: SessionConfigurationValue;
}

export interface SessionConfigurationSnapshot {
  precedence: string[];
  defaultProvider: SessionConfigurationValue;
  defaultModel: SessionConfigurationValue;
  phases: SessionPhaseConfiguration[];
  fallbacks: string[];
  overrides: string[];
}

export interface SessionCommit {
  hash: string;
  subject: string;
  committedAt?: string | null;
  storyId?: string | null;
}

export interface SessionPullRequest {
  number: number;
  url: string;
  title: string;
}
