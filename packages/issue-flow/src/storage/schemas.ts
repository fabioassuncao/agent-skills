import { z } from 'zod';
import type { ExecutionPlan } from '../execution/types.js';
import { pullRequestRefSchema, webConfigSchema } from '../schemas.js';

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

/** Global commit preferences. Consumed by later issues, not by this release. */
export const globalCommitConfigSchema = z
  .object({
    signoff: z.boolean(),
    conventional: z.boolean(),
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
    web: globalWebConfigSchema,
    retry: globalRetryConfigSchema,
    commit: globalCommitConfigSchema,
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
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  origin: z.enum(['requested', 'discovered']),
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
});

export const executionPlanSchema = z.object({
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

export type ProjectMetadata = z.infer<typeof projectMetadataSchema>;
export type ValidatedExecutionPlan = z.infer<typeof executionPlanSchema>;
export type GlobalWebConfig = z.infer<typeof globalWebConfigSchema>;
export type GlobalRetryConfig = z.infer<typeof globalRetryConfigSchema>;
export type GlobalCommitConfig = z.infer<typeof globalCommitConfigSchema>;
export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type WebLock = z.infer<typeof webLockSchema>;
