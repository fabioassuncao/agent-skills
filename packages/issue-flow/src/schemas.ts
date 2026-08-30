import { z } from 'zod';
import type { ClaudeUsage } from './core/metrics.js';
import type { SessionSnapshot } from './core/session-state.js';
import type { IssueMetadata, IssuesConfig } from './issues/types.js';

/**
 * Zod schemas for validating tasks.json structure, Issue metadata, headless
 * invocation outputs, the web monitoring session snapshot and the web
 * configuration.
 */

/**
 * Token/cost metrics of a single `claude` invocation, mirroring ClaudeUsage in
 * src/core/metrics.ts. Every field is optional: the CLI only reports what it
 * knows, and an absent field means "not reported", never zero.
 */
export const claudeUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  costUsd: z.number().optional(),
}) satisfies z.ZodType<ClaudeUsage>;

export const userStoryStatusSchema = z.enum(['backlog', 'in_progress', 'in_review', 'done']);

/**
 * Fine-grained execution stage — mirrors `StoryStage` in `src/types.ts`. See
 * that type's doc comment for what each value means and which pipeline event
 * produces it.
 */
export const storyStageSchema = z.enum([
  'pending',
  'executing',
  'awaiting_review',
  'in_review',
  'in_correction',
  'done',
  'failed',
]);

/**
 * The metrics fields are additive and optional: plans written before they
 * existed keep parsing, and nothing is filled in with artificial zeros.
 *
 * `status` and `dependencies` follow the same rule and are `.optional()` rather
 * than `.default()` on purpose: a legacy plan must not gain a `'backlog'` and an
 * empty array it never declared just because `saveTaskPlan` rewrote it. `stage`
 * and friends follow the exact same treatment — nothing in the pipeline writes
 * them back onto `tasks.json`, so they stay `.optional()` too.
 */
export const userStorySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  priority: z.number().int().positive(),
  passes: z.boolean(),
  notes: z.string(),
  ...claudeUsageSchema.shape,
  durationSeconds: z.number().optional(),
  status: userStoryStatusSchema.optional(),
  dependencies: z.array(z.string()).optional(),
  stage: storyStageSchema.optional(),
  stageSince: z.string().optional(),
  stageDetail: z.string().optional(),
});

export const pipelineStateSchema = z.object({
  analyzeCompleted: z.boolean().optional(),
  prdCompleted: z.boolean(),
  jsonCompleted: z.boolean(),
  executionCompleted: z.boolean(),
  reviewCompleted: z.boolean(),
  prCreated: z.boolean(),
  prReviewCompleted: z.boolean().optional(),
});

/**
 * Pull Request opened by the `pr` phase. Optional on the plan: plans written
 * before the field existed (and runs with `--no-branch`) simply omit it.
 */
export const pullRequestRefSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  headBranch: z.string(),
  createdAt: z.string(),
});

export const prReviewRecommendationSchema = z.enum([
  'APPROVE',
  'APPROVE_WITH_SUGGESTIONS',
  'REQUEST_CHANGES',
]);

/**
 * State of the opt-in `pr-review` phase. `enabled` and `rounds` carry defaults
 * so a partially written object still parses instead of invalidating the plan.
 */
export const prReviewStateSchema = z.object({
  enabled: z.boolean().default(false),
  pullRequestNumber: z.number().int().positive().optional(),
  rounds: z.number().int().min(0).default(0),
  lastRecommendation: prReviewRecommendationSchema.optional(),
  lastReviewedAt: z.string().optional(),
});

const lastErrorSchema = z.object({
  category: z.string(),
  message: z.string(),
  at: z.string(),
});

/**
 * Persisted metadata for an Issue stored on disk (issues/<id>/metadata.json).
 * `satisfies` keeps this schema in lockstep with the IssueMetadata interface in
 * src/issues/types.ts — changing one without the other fails the typecheck.
 */
export const issueMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  number: z.number().int().positive().nullable(),
  source: z.enum(['github', 'local']),
  title: z.string(),
  labels: z.array(z.string()),
  state: z.enum(['open', 'closed']),
  createdAt: z.string(),
  updatedAt: z.string(),
  contentHash: z.string(),
  remote: z
    .object({
      provider: z.enum(['github', 'local']),
      ref: z.string(),
      syncedAt: z.string(),
      syncedContentHash: z.string(),
    })
    .optional(),
}) satisfies z.ZodType<IssueMetadata>;

/**
 * tasks.json structure. Deliberately permissive: plans written by older
 * versions must keep loading, so `issueUrl` is optional (Issues with no remote
 * have no URL) and `issueNumber` accepts non-numeric local identifiers.
 */
/**
 * `TaskPlan.runState`, written by the pipeline and read on resumption.
 *
 * Optional as a whole — a plan from before it existed has none — but every
 * field inside carries a default, so a partially written object (a process
 * killed mid-write) still parses into a usable state instead of invalidating
 * the plan. That is the same discipline `prReviewStateSchema` follows.
 */
export const runOwnerSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  startedAt: z.string(),
});

export const issueRunStateSchema = z.object({
  status: z
    .enum(['idle', 'running', 'waiting', 'retrying', 'paused', 'blocked', 'failed'])
    .default('idle'),
  currentPhase: z.string().nullable().default(null),
  attempt: z.number().int().min(0).default(0),
  lastHeartbeatAt: z.string().nullable().default(null),
  blockedReason: z.string().nullable().default(null),
  owner: runOwnerSchema.nullable().default(null),
});

export const taskPlanSchema = z.object({
  project: z.string(),
  issueNumber: z.union([z.number().int().positive(), z.string().min(1)]),
  issueUrl: z.string().optional().default(''),
  branchName: z.string(),
  noBranch: z.boolean().optional().default(false),
  description: z.string(),
  issueStatus: z.enum(['pending', 'in_progress', 'completed']),
  completedAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  lastError: lastErrorSchema.nullable(),
  correctionCycle: z.number().int().min(0),
  maxCorrectionCycles: z.number().int().min(0),
  /**
   * Findings from the most recent failed review, verbatim. Non-null means the
   * issue has a pending correction even if every userStories[].passes is
   * already true — the execute phase must address these before the field is
   * cleared back to null. See core/engine.ts's early-return guards.
   */
  lastReviewFindings: z.string().nullable().optional().default(null),
  pipeline: pipelineStateSchema,
  /**
   * Where the run stands right now. Purely additive: absent in every plan
   * written before it, and absent is not the same as `idle` — it means the
   * plan predates the field, which is why there is no `.default()` here.
   */
  runState: issueRunStateSchema.optional(),
  pullRequest: pullRequestRefSchema.optional(),
  prReview: prReviewStateSchema.optional(),
  userStories: z.array(userStorySchema),
});

export const headlessResultSchema = z.object({
  success: z.boolean(),
  result: z.string(),
  cost: claudeUsageSchema.nullable(),
  error: z.string().nullable(),
});

const sessionLogEntrySchema = z.object({
  at: z.string(),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
});

/**
 * Usage counters attached to a phase or a story in the session snapshot.
 * Unlike claudeUsageSchema (a single invocation, optional fields), these are
 * always present and nullable: null means "never reported", not zero.
 *
 * They default to null on input so a session.json written before the metrics
 * existed still parses -- absent and null mean the same thing here, and the
 * parsed value keeps the `number | null` shape the snapshot interface declares.
 */
const sessionUsageShape = {
  inputTokens: z.number().nullable().default(null),
  outputTokens: z.number().nullable().default(null),
  cacheReadTokens: z.number().nullable().default(null),
  cacheCreationTokens: z.number().nullable().default(null),
  costUsd: z.number().nullable().default(null),
};

const sessionPhaseSchema = z.object({
  name: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  error: z.string().nullable(),
  ...sessionUsageShape,
});

const sessionStorySchema = z.object({
  id: z.string(),
  title: z.string(),
  priority: z.number(),
  passes: z.boolean(),
  completedAt: z.string().nullable(),
  // Also introduced with the metrics, hence the same tolerant default.
  durationSeconds: z.number().nullable().default(null),
  // Snapshot fields are always present on output and defaulted on input, so a
  // session.json written before they existed still parses. This is the mirror
  // image of userStorySchema, where the same two fields are plainly optional.
  status: userStoryStatusSchema.default('backlog'),
  dependencies: z.array(z.string()).default([]),
  // Published for the panel's story detail view. Same tolerant default as the
  // fields above: absent (older session.json) and empty resolve to the same
  // value, so the client never has to tell them apart.
  description: z.string().default(''),
  acceptanceCriteria: z.array(z.string()).default([]),
  // Additive like the rest of this schema: a session.json written before
  // `stage` existed parses into 'pending'/null, the same values a fresh
  // snapshot starts a story at.
  stage: storyStageSchema.default('pending'),
  stageSince: z.string().nullable().default(null),
  stageDetail: z.string().nullable().default(null),
  ...sessionUsageShape,
});

/**
 * Session snapshot served by the web monitoring mode (session.json and the
 * HTTP endpoint). `satisfies` keeps this schema in lockstep with the
 * SessionSnapshot interface in src/core/session-state.ts — changing one
 * without the other fails the typecheck.
 */
export const sessionSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().nullable(),
  readOnly: z.literal(true),
  capabilities: z.array(z.string()),
  issue: z.object({
    number: z.number().nullable(),
    url: z.string().nullable(),
    // Additive: a session.json written before the Issue section was enriched
    // parses into the same "not reported" values createInitialSnapshot() uses.
    title: z.string().nullable().default(null),
    description: z.string().nullable().default(null),
    labels: z.array(z.string()).default([]),
    state: z.string().nullable().default(null),
  }),
  status: z.enum(['idle', 'running', 'completed', 'failed']),
  startedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  elapsedSeconds: z.number().nullable(),
  estimatedRemainingSeconds: z.number().nullable(),
  progress: z.object({
    percent: z.number(),
    phasesCompleted: z.number(),
    phasesTotal: z.number(),
    storiesCompleted: z.number(),
    storiesTotal: z.number(),
  }),
  currentPhase: z.string().nullable(),
  currentActivity: z
    .object({
      story: z.string().nullable(),
      tool: z.string().nullable(),
      detail: z.string().nullable(),
      since: z.string(),
    })
    .nullable(),
  phases: z.array(sessionPhaseSchema),
  stories: z.array(sessionStorySchema),
  // The whole aggregate is additive: a snapshot from before it existed parses
  // into the same "nothing reported" object the reducer starts from.
  metrics: z
    .object({
      totalInputTokens: z.number().nullable().default(null),
      totalOutputTokens: z.number().nullable().default(null),
      totalCacheReadTokens: z.number().nullable().default(null),
      totalCacheCreationTokens: z.number().nullable().default(null),
      totalCostUsd: z.number().nullable().default(null),
    })
    .default({
      totalInputTokens: null,
      totalOutputTokens: null,
      totalCacheReadTokens: null,
      totalCacheCreationTokens: null,
      totalCostUsd: null,
    }),
  execution: z.object({
    iteration: z.number(),
    retries: z.number(),
    correctionCycle: z.number(),
    maxCorrectionCycles: z.number().nullable(),
  }),
  // Additive resilience projection. Every field defaults so session.json from
  // before provider failover/observability remains readable without a schema
  // version bump.
  resilience: z
    .object({
      attempt: z.number().int().nonnegative().default(0),
      provider: z.string().nullable().default(null),
      model: z.string().nullable().default(null),
      lastFailureKind: z
        .enum([
          'network',
          'timeout',
          'stalled',
          'rate_limit',
          'provider_down',
          'provider_crash',
          'authentication',
          'configuration',
          'repository_state',
          'task_execution',
          'internal',
          'unknown',
        ])
        .nullable()
        .default(null),
      cooldownUntil: z.string().nullable().default(null),
      lastActivityAt: z.string().nullable().default(null),
    })
    .default({
      attempt: 0,
      provider: null,
      model: null,
      lastFailureKind: null,
      cooldownUntil: null,
      lastActivityAt: null,
    }),
  git: z.object({
    branch: z.string().nullable(),
    baseBranch: z.string().nullable(),
    commits: z.array(z.object({ hash: z.string(), subject: z.string() })),
  }),
  // Additive like the metrics aggregate: a session.json written before the
  // repository section existed parses into the same all-null object
  // createInitialSnapshot() starts from.
  repository: z
    .object({
      name: z.string().nullable().default(null),
      remoteUrl: z.string().nullable().default(null),
      branch: z.string().nullable().default(null),
      headCommit: z.string().nullable().default(null),
      root: z.string().nullable().default(null),
    })
    .default({ name: null, remoteUrl: null, branch: null, headCommit: null, root: null }),
  pullRequests: z.array(z.object({ number: z.number(), url: z.string(), title: z.string() })),
  logs: z.array(sessionLogEntrySchema),
  errors: z.array(sessionLogEntrySchema),
  warnings: z.array(sessionLogEntrySchema),
  lastError: z.object({ message: z.string(), at: z.string() }).nullable(),
  nextSteps: z.array(z.string()),
  environment: z
    .object({
      node: z.string(),
      platform: z.string(),
      agent: z.string().nullable().default(null),
      model: z.string().nullable().default(null),
    })
    .nullable(),
}) satisfies z.ZodType<SessionSnapshot>;

/**
 * Resolved web monitoring configuration. Every field has a default, so
 * parsing a partial object (e.g. the `web` key of .issue-flow.json) fills in
 * the documented defaults.
 */
export const webConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(3737),
  host: z.string().min(1).default('0.0.0.0'),
  refreshSeconds: z.number().positive().default(5),
  logLimit: z.number().int().positive().default(200),
  includeLogs: z.boolean().default(true),
});

/**
 * Resolved Issue provider configuration. Every field has a default that keeps
 * the GitHub-only behaviour, so parsing an empty object yields the exact
 * behaviour of releases without the provider layer.
 */
export const issuesConfigSchema = z.object({
  defaultGenerateTarget: z.enum(['github', 'local', 'both']).default('github'),
  preferredProvider: z.enum(['github', 'local']).default('github'),
  conflictPolicy: z.enum(['ask', 'prefer-local', 'prefer-github']).default('ask'),
  requireConfirmation: z.boolean().default(true),
}) satisfies z.ZodType<IssuesConfig>;

/**
 * Resolved `pr-review` configuration (the `prReview` key of .issue-flow.json).
 *
 * `publisher` selects the implementation `createPrReviewPublisher()` builds:
 * `local` writes the artifacts under the issue directory, and `github` does
 * that **and** comments on the Pull Request, updating the comment of the same
 * round instead of stacking a new one on every republication.
 *
 * `local` stays the default, so a repository that configures nothing publishes
 * exactly where it always did and never writes to GitHub by surprise.
 */
export const prReviewConfigSchema = z.object({
  publisher: z.enum(['local', 'github']).default('local'),
});

/**
 * The `policy` key of .issue-flow.json — the repository policy layer. Defined
 * in `policy/schemas.ts` next to the module that consumes it, and re-exported
 * here so `schemas.ts` stays the single index of the file's keys.
 */
export {
  type PolicyConfig,
  type PolicyConfigInput,
  type PolicyDiscoveryConfig,
  policyConfigInputSchema,
  policyConfigSchema,
  policyDiscoveryConfigSchema,
} from './policy/schemas.js';

export type ValidatedTaskPlan = z.infer<typeof taskPlanSchema>;
export type ValidatedIssueMetadata = z.infer<typeof issueMetadataSchema>;
export type ValidatedHeadlessResult = z.infer<typeof headlessResultSchema>;
export type ValidatedSessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type WebConfig = z.infer<typeof webConfigSchema>;
export type PrReviewConfig = z.infer<typeof prReviewConfigSchema>;
