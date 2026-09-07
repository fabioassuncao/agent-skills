import { z } from 'zod';
import { agentConfigInputSchema } from '../agents/schemas.js';
import type { ExecutionPlan } from '../execution/types.js';
import type {
  ExhaustedAction,
  FailoverMode,
  PolicyConfig as ResiliencePolicyConfig,
  ResilienceProfile,
  RetryConfigKey,
  RetryPolicy,
} from '../resilience/policy.js';
import { pullRequestRefSchema, routingConfigInputSchema, webConfigSchema } from '../schemas.js';

/**
 * Zod schemas for the files written under the global storage tree
 * (`~/.issue-flow`): the per-project `metadata.json` and the global
 * `config.json`.
 *
 * They live here rather than in `src/schemas.ts` so that file stays focused on
 * the pipeline domain (task plans, Issue metadata, session snapshots) and the
 * storage layer keeps owning its own formats.
 */

/** Version stamped on files written by this release of the storage layer. */
export const STORAGE_SCHEMA_VERSION = 1;

/**
 * Where a `plan` run's `US-NNN` numbering came from (issue #36):
 *
 * - `history`: recovered from the highest number already used anywhere in the
 *   project's `tasks.json` files, automatically or via `--continue`.
 * - `start-us`: forced by the user via `--start-us <n>`, ignoring history.
 * - `none`: no history found (the project's first `plan` run) — starts at
 *   `US-001`.
 */
export const userStoryNumberingSourceSchema = z.enum(['history', 'start-us', 'none']);

/**
 * A single numbering decision, persisted for audit under
 * `metadata.json`'s `userStoryNumbering` (see below) — never used to resolve
 * the *next* decision, which always re-scans `tasks.json` from scratch.
 */
export const userStoryNumberingDecisionSchema = z.object({
  /** The `US-NNN` number the `plan` prompt was told to continue from. */
  nextNumber: z.number().int().positive(),
  source: userStoryNumberingSourceSchema,
  /** Issue the decision was made for. */
  issueNumber: z.string().min(1),
  decidedAt: z.string().min(1),
  /** Human-readable origin, e.g. the previous story id and issue it came from. */
  detail: z.string().optional(),
});

/**
 * `~/.issue-flow/projects/<project-id>/metadata.json`.
 *
 * Deliberately **not** `.strict()`: a newer release may add fields (dashboard
 * history, counters) and an older one must still be able to read the file
 * instead of rejecting it. Unknown keys are dropped on parse, never fatal.
 *
 * `root` is the last known local checkout — informative only. Identity lives in
 * `projectId` (see `getProjectId()` in `paths.ts`), so moving the folder of a
 * project that has a remote updates `root` without changing the id.
 */
export const projectMetadataSchema = z.object({
  schemaVersion: z.number().int().positive(),
  projectId: z.string().min(1),
  root: z.string().min(1),
  /** Normalized remote (`host/org/repo`), or null when the project has none. */
  remoteUrl: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  /** Null until the project is used by a pipeline run. */
  lastAttemptAt: z.string().nullable(),
  /**
   * Most recent User Story numbering decision made by `plan` (issue #36).
   * Absent on a project whose `plan` never ran through the numbering
   * resolver, or on a `metadata.json` written before the feature existed.
   */
  userStoryNumbering: userStoryNumberingDecisionSchema.optional(),
});

/**
 * Global counterpart of the `web` key of `.issue-flow.json`, restricted to the
 * settings that make sense machine-wide: `enabled` and `includeLogs` stay a
 * per-project decision.
 *
 * The validation of each field is reused from `webConfigSchema` through
 * `.unwrap()`, which strips the `.default()` and keeps the constraints. Picking
 * and calling `.partial()` would not be enough: in zod 4 an optional field
 * still materializes its default when the key is absent
 * (`z.object({ port: z.number().default(3737) }).partial().parse({})` yields
 * `{ port: 3737 }`), and a materialized default in this layer would override
 * the project layer during the merge.
 */
const webShape = webConfigSchema.shape;
export const globalWebConfigSchema = z
  .object({
    port: webShape.port.unwrap(),
    host: webShape.host.unwrap(),
    refreshSeconds: webShape.refreshSeconds.unwrap(),
    logLimit: webShape.logLimit.unwrap(),
  })
  .partial();

/** Global retry preferences, mirroring `DEFAULTS` in `config.ts`. */
export const globalRetryConfigSchema = z
  .object({
    retryLimit: z.number().int().nonnegative(),
    retryForever: z.boolean(),
    backoffBaseSeconds: z.number().nonnegative(),
    backoffMaxSeconds: z.number().nonnegative(),
  })
  .partial();

/* ── the `resilience` key ───────────────────────────────────────────────── */

/**
 * The file format of the `resilience` key, shared by `.issue-flow.json` and
 * `~/.issue-flow/config.json` — the same object is accepted in both, because
 * they are two rungs of one ladder rather than two formats.
 *
 * **Every field is optional and none carries a `.default()`**, for the reason
 * stated on `globalConfigSchema` below and in `AGENTS.md`: both files are
 * intermediate precedence layers, and a default materialized in one of them is
 * indistinguishable from a value the user wrote.
 *
 * The enums are pinned to the types of `resilience/policy.ts` with `satisfies`,
 * so a value the resolver understands and the file rejects (or the reverse) is
 * a compile error rather than a silent drop at parse time.
 */
const resilienceProfileSchema = z.enum([
  'default',
  'continuous',
]) satisfies z.ZodType<ResilienceProfile>;
const jitterSchema = z.enum(['none', 'full']) satisfies z.ZodType<RetryPolicy['jitter']>;
const failoverModeSchema = z.enum([
  'never',
  'after_attempts',
  'immediate',
]) satisfies z.ZodType<FailoverMode>;
const exhaustedActionSchema = z.enum(['fail', 'block']) satisfies z.ZodType<ExhaustedAction>;

/** One `resilience.retry.<kind>` entry — a partial `RetryPolicy`. */
export const retryPolicyOverrideSchema = z
  .object({
    maxAttempts: z.number().int().nonnegative(),
    initialDelayMs: z.number().nonnegative(),
    maxDelayMs: z.number().nonnegative(),
    backoffFactor: z.number().min(1),
    jitter: jitterSchema,
    retryForever: z.boolean(),
    failover: failoverModeSchema,
    failoverAfterAttempts: z.number().int().positive(),
    onExhausted: exhaustedActionSchema,
  })
  .partial();

/**
 * `resilience.retry`, one optional entry per `FailureKind`.
 *
 * Built from a `Record<RetryConfigKey, …>` on purpose: adding a `FailureKind`
 * without giving it a configuration key stops compiling here.
 */
const retryOverridesByKind: Record<RetryConfigKey, typeof retryPolicyOverrideSchema> = {
  network: retryPolicyOverrideSchema,
  timeout: retryPolicyOverrideSchema,
  stalled: retryPolicyOverrideSchema,
  rateLimit: retryPolicyOverrideSchema,
  providerDown: retryPolicyOverrideSchema,
  providerCrash: retryPolicyOverrideSchema,
  authentication: retryPolicyOverrideSchema,
  configuration: retryPolicyOverrideSchema,
  repositoryState: retryPolicyOverrideSchema,
  taskExecution: retryPolicyOverrideSchema,
  internal: retryPolicyOverrideSchema,
  unknown: retryPolicyOverrideSchema,
};

export const resilienceRetryConfigSchema = z.object(retryOverridesByKind).partial();

/** `resilience.providers` — agent health and failover (US-024, US-025). */
export const resilienceProvidersConfigSchema = z
  .object({
    failover: z.boolean(),
    chain: z.array(z.string().min(1)),
    cooldownMs: z.number().nonnegative(),
    maxCooldownMs: z.number().nonnegative(),
    failureWindowMs: z.number().positive(),
    failuresToTrip: z.number().int().positive(),
  })
  .partial();

export const providerHealthStatusSchema = z.enum([
  'healthy',
  'degraded',
  'unavailable',
  'rate_limited',
  'auth_failed',
  'half_open',
]);

export const providerHealthRecordSchema = z.object({
  status: providerHealthStatusSchema.default('healthy'),
  failures: z
    .array(
      z.object({
        at: z.string(),
        kind: z.enum([
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
        ]),
      }),
    )
    .default([]),
  consecutiveFailures: z.number().int().nonnegative().default(0),
  cooldownLevel: z.number().int().nonnegative().default(0),
  cooldownUntil: z.string().nullable().default(null),
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
  lastFailureAt: z.string().nullable().default(null),
  lastSuccessAt: z.string().nullable().default(null),
  probeInFlight: z.boolean().default(false),
  probeStartedAt: z.string().nullable().default(null),
});

export const providersHealthSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  providers: z.record(z.string(), providerHealthRecordSchema).default({}),
});

/** `resilience.queue` — what a failing issue does to the rest of them (US-027). */
export const resilienceQueueConfigSchema = z
  .object({
    onIssueFailure: z.enum(['stop', 'skip', 'block']),
    maxIssueAttempts: z.number().int().positive(),
  })
  .partial();

/** `resilience.watchdog` — inactivity detection over the event stream (US-026). */
export const resilienceWatchdogConfigSchema = z
  .object({
    inactivityTimeoutMs: z.number().int().nonnegative(),
  })
  .partial();

/** `resilience.journal` — the append-only `events.jsonl` (US-015). */
export const resilienceJournalConfigSchema = z
  .object({
    enabled: z.boolean(),
    maxFileBytes: z.number().int().positive(),
  })
  .partial();

/** `resilience.decompose` — the "this issue is too large" report (US-030). */
export const resilienceDecomposeConfigSchema = z
  .object({
    auto: z.boolean(),
  })
  .partial();

export const resilienceConfigSchema = z
  .object({
    profile: resilienceProfileSchema,
    /** Whether a credential failure may migrate to another provider. */
    failoverOnAuth: z.boolean(),
    retry: resilienceRetryConfigSchema,
    providers: resilienceProvidersConfigSchema,
    queue: resilienceQueueConfigSchema,
    watchdog: resilienceWatchdogConfigSchema,
    journal: resilienceJournalConfigSchema,
    decompose: resilienceDecomposeConfigSchema,
  })
  .partial();

/**
 * Intermediate `telemetry` key. Every field optional, no `.default()` — this
 * file is a middle rung of the config ladder.
 */
export const telemetryPricingOverrideSchema = z
  .object({
    inputPerMillion: z.number(),
    outputPerMillion: z.number(),
    cacheReadPerMillion: z.number(),
    cacheWritePerMillion: z.number(),
  })
  .partial();

export const telemetryConfigInputSchema = z
  .object({
    enabled: z.boolean(),
    maxExecutions: z.number().int().positive(),
    pricing: z
      .object({
        estimate: z.boolean(),
        overrides: z.record(z.string(), telemetryPricingOverrideSchema),
      })
      .partial(),
  })
  .partial();

/** Global commit preferences. `signoff` is consumed by `commitMessage()`. */
export const globalCommitConfigSchema = z
  .object({
    signoff: z.boolean(),
    conventional: z.boolean(),
  })
  .partial();

/**
 * SQLite adoption controls. They deliberately live in a separate `storage`
 * object so choosing the compatibility driver cannot be confused with the
 * location of the global storage tree (`storageDir`).
 */
export const storageConfigInputSchema = z
  .object({
    /** Keep legacy JSON as the active driver, for recovery or a staged rollout. */
    driver: z.enum(['sqlite', 'json']),
    /** Number of pre-migration database snapshots to retain. */
    backupRetention: z.number().int().nonnegative(),
    /** Explicit row-retention policy. Omitted values mean retain history. */
    retention: z
      .object({
        executions: z.number().int().nonnegative(),
        events: z.number().int().nonnegative(),
        snapshots: z.number().int().nonnegative(),
        backups: z.number().int().nonnegative(),
      })
      .partial(),
  })
  .partial();

/**
 * `~/.issue-flow/config.json`.
 *
 * **Every key is optional and no key carries a `.default()`.** This is a design
 * constraint, not an omission: the global file is an intermediate precedence
 * layer (CLI > env > `.issue-flow.json` > `config.json` > defaults), so a
 * default materialized here would be indistinguishable from a value the user
 * actually wrote and would silently override the project layer during the
 * merge. Same reason `readWebConfigFile()` parses with
 * `webConfigSchema.partial()`. Defaults belong to the final layer only.
 */
export const globalConfigSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    /** Override for the directory holding `projects/`. */
    storageDir: z.string().min(1),
    storage: storageConfigInputSchema,
    web: globalWebConfigSchema,
    retry: globalRetryConfigSchema,
    commit: globalCommitConfigSchema,
    resilience: resilienceConfigSchema,
    agent: agentConfigInputSchema,
    telemetry: telemetryConfigInputSchema,
    routing: routingConfigInputSchema,
    /** Machine-wide custom agents; projects may override or mask them by id. */
    // Entry validation is deliberately owned by config/custom-agents.ts so a
    // malformed agent cannot make otherwise valid global preferences vanish.
    agents: z.record(z.string(), z.unknown()),
  })
  .partial();

/**
 * `~/.issue-flow/web.lock`.
 *
 * Marks the single web monitoring server active on this machine: `pid` and
 * `port` let a new invocation tell a live instance from a stale one before
 * attempting to bind its own (see `web/lock.ts`). Not `.strict()` for the same
 * reason as the schemas above — a newer release may add fields.
 */
export const webLockSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  host: z.string().min(1),
  startedAt: z.string().min(1),
  /** Added in a backward-compatible way: locks from older releases remain valid. */
  instanceId: z.string().min(1).optional(),
});

/**
 * `~/.issue-flow/projects/<project-id>/run.lock`.
 *
 * Ownership of a run, so a second invocation in the same project refuses
 * instead of fighting the first one over `tasks.json` and the branch. Same
 * shape of guard as `web.lock` — a pid, a host and a timestamp — plus the
 * heartbeat that tells a dead owner from a slow one.
 *
 * No field defaults: a lock is written whole by its owner, and a half-read one
 * degrades to "no lock" at the reader, exactly like `readWebLock`.
 */
export const runLockSchema = z.object({
  pid: z.number().int().positive(),
  /** Unique possession identity; absent only on locks written by older releases. */
  ownerId: z.string().min(1).optional(),
  /** `os.hostname()`. A pid only means something on the host that wrote it. */
  host: z.string().min(1),
  /** The issue (or queue) identifier the owner is running. */
  target: z.string().min(1),
  startedAt: z.string().min(1),
  lastHeartbeatAt: z.string().min(1),
  /** Absent on a foreground run written before this field existed. */
  detached: z.boolean().optional(),
});

/**
 * `~/.issue-flow/projects/<project-id>/queues/<queue-id>/execution-plan.json`.
 *
 * The coordination state of a multi-issue run: which Issues, in which order, on
 * which shared branch, and how far the queue got. Each Issue keeps its own
 * `tasks.json` — nothing of the task plan is duplicated here.
 *
 * Written only when a queue really has more than one Issue: a single-issue run
 * creates no queue directory at all, which is what keeps the storage layout of
 * every existing user unchanged.
 *
 * Not `.strict()`, like every other file schema here, and `satisfies` keeps it
 * in lockstep with the `ExecutionPlan` interface in `src/execution/types.ts`.
 */
export const executionPlanIssueSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive().nullable(),
  title: z.string(),
  url: z.string().nullable(),
  source: z.string().min(1),
  position: z.number().int().positive(),
  // `blocked` and `skipped` are additive: no plan written before them can
  // carry one, and a reader that does not know them was never given one.
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'blocked', 'skipped']),
  origin: z.enum(['requested', 'discovered']),
  role: z.enum(['executable', 'container']).default('executable'),
  externalDependencies: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  parent: z.string().nullable().default(null),
  priority: z.enum(['high', 'medium', 'low']).nullable().default(null),
  heuristic: z.boolean().default(false),
  failedPhase: z.string().nullable().default(null),
  lastError: z
    .object({ category: z.string(), message: z.string(), at: z.string() })
    .nullable()
    .default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  // Both default, so an execution-plan.json written by an earlier release
  // parses unchanged and reads as "never attempted, not blocked".
  attempts: z.number().int().min(0).default(0),
  blockedReason: z.string().nullable().default(null),
});

export const executionPlanSchema = z.object({
  closeIssue: z.boolean().optional(),
  closedIssueIds: z.array(z.string()).optional(),
  prReviewCompleted: z.boolean().optional(),
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  project: z.string().min(1),
  requested: z.array(z.string().min(1)),
  branchName: z.string().nullable().default(null),
  noBranch: z.boolean().default(false),
  prReview: z.boolean().default(false),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  truncated: z.boolean().default(false),
  issues: z.array(executionPlanIssueSchema),
  excluded: z
    .array(
      z.object({
        id: z.string().min(1),
        number: z.number().int().positive().nullable(),
        title: z.string(),
        url: z.string().nullable(),
        reason: z.string(),
      }),
    )
    .default([]),
  pullRequest: pullRequestRefSchema.optional(),
}) satisfies z.ZodType<ExecutionPlan>;

export type UserStoryNumberingSource = z.infer<typeof userStoryNumberingSourceSchema>;
export type UserStoryNumberingDecision = z.infer<typeof userStoryNumberingDecisionSchema>;
export type ProjectMetadata = z.infer<typeof projectMetadataSchema>;
export type ValidatedExecutionPlan = z.infer<typeof executionPlanSchema>;
export type GlobalWebConfig = z.infer<typeof globalWebConfigSchema>;
export type GlobalRetryConfig = z.infer<typeof globalRetryConfigSchema>;
export type GlobalCommitConfig = z.infer<typeof globalCommitConfigSchema>;
export type StorageConfigInput = z.infer<typeof storageConfigInputSchema>;
export type ResilienceRetryConfig = z.infer<typeof resilienceRetryConfigSchema>;
export type ResilienceProvidersConfig = z.infer<typeof resilienceProvidersConfigSchema>;
export type ProviderHealthStatus = z.infer<typeof providerHealthStatusSchema>;
export type ProviderHealthRecord = z.infer<typeof providerHealthRecordSchema>;
export type ProvidersHealth = z.infer<typeof providersHealthSchema>;
export type ResilienceQueueConfig = z.infer<typeof resilienceQueueConfigSchema>;
export type ResilienceWatchdogConfig = z.infer<typeof resilienceWatchdogConfigSchema>;
export type ResilienceJournalConfig = z.infer<typeof resilienceJournalConfigSchema>;
export type ResilienceDecomposeConfig = z.infer<typeof resilienceDecomposeConfigSchema>;
export type ResilienceConfig = z.infer<typeof resilienceConfigSchema>;
export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type TelemetryConfigInput = z.infer<typeof telemetryConfigInputSchema>;

/**
 * The file format is a *superset* of what `resolvePolicy()` reads: it also
 * carries `providers`, `queue`, `watchdog`, `journal` and `decompose`, which
 * belong to later layers. This alias is the compile-time proof of the "superset"
 * half — a drift between the two shapes fails to build here rather than at the
 * first call site that passes one to the other.
 */
type Assert<T extends true> = T;
export type ResilienceConfigIsPolicyConfig = Assert<
  ResilienceConfig extends ResiliencePolicyConfig ? true : false
>;
export type WebLock = z.infer<typeof webLockSchema>;
export type RunLock = z.infer<typeof runLockSchema>;
