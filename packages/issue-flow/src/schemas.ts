import { z } from 'zod';
import type { SessionSnapshot } from './core/session-state.js';
import type { IssueMetadata, IssuesConfig } from './issues/types.js';

/**
 * Zod schemas for validating tasks.json structure, Issue metadata, headless
 * invocation outputs, the web monitoring session snapshot and the web
 * configuration.
 */

export const userStorySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  priority: z.number().int().positive(),
  passes: z.boolean(),
  notes: z.string(),
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
  pullRequest: pullRequestRefSchema.optional(),
  prReview: prReviewStateSchema.optional(),
  userStories: z.array(userStorySchema),
});

export const headlessResultSchema = z.object({
  success: z.boolean(),
  result: z.string(),
  cost: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
    })
    .nullable(),
  error: z.string().nullable(),
});

const sessionLogEntrySchema = z.object({
  at: z.string(),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
});

const sessionPhaseSchema = z.object({
  name: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  error: z.string().nullable(),
});

const sessionStorySchema = z.object({
  id: z.string(),
  title: z.string(),
  priority: z.number(),
  passes: z.boolean(),
  completedAt: z.string().nullable(),
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
  issue: z.object({ number: z.number().nullable(), url: z.string().nullable() }),
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
  execution: z.object({
    iteration: z.number(),
    retries: z.number(),
    correctionCycle: z.number(),
    maxCorrectionCycles: z.number().nullable(),
  }),
  git: z.object({
    branch: z.string().nullable(),
    baseBranch: z.string().nullable(),
    commits: z.array(z.object({ hash: z.string(), subject: z.string() })),
  }),
  pullRequests: z.array(z.object({ number: z.number(), url: z.string(), title: z.string() })),
  logs: z.array(sessionLogEntrySchema),
  errors: z.array(sessionLogEntrySchema),
  warnings: z.array(sessionLogEntrySchema),
  lastError: z.object({ message: z.string(), at: z.string() }).nullable(),
  nextSteps: z.array(z.string()),
  environment: z.object({ node: z.string(), platform: z.string() }).nullable(),
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
 * `publisher` selects the implementation `createPrReviewPublisher()` builds. v1
 * ships only the local one, so the enum has a single member on purpose: adding
 * a GitHub adapter is a new entry here plus a new factory, never a change to
 * the phase.
 */
export const prReviewConfigSchema = z.object({
  publisher: z.enum(['local']).default('local'),
});

export type ValidatedTaskPlan = z.infer<typeof taskPlanSchema>;
export type ValidatedIssueMetadata = z.infer<typeof issueMetadataSchema>;
export type ValidatedHeadlessResult = z.infer<typeof headlessResultSchema>;
export type ValidatedSessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type WebConfig = z.infer<typeof webConfigSchema>;
export type PrReviewConfig = z.infer<typeof prReviewConfigSchema>;
