import { z } from 'zod';
import type { SessionSnapshot } from './core/session-state.js';

/**
 * Zod schemas for validating tasks.json structure, headless invocation
 * outputs, the web monitoring session snapshot and the web configuration.
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
});

const lastErrorSchema = z.object({
  category: z.string(),
  message: z.string(),
  at: z.string(),
});

export const taskPlanSchema = z.object({
  project: z.string(),
  issueNumber: z.number().int().positive(),
  issueUrl: z.string(),
  branchName: z.string(),
  noBranch: z.boolean().optional().default(false),
  description: z.string(),
  issueStatus: z.enum(['pending', 'in_progress', 'completed']),
  completedAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  lastError: lastErrorSchema.nullable(),
  correctionCycle: z.number().int().min(0),
  maxCorrectionCycles: z.number().int().min(0),
  pipeline: pipelineStateSchema,
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
  host: z.string().min(1).default('127.0.0.1'),
  refreshSeconds: z.number().positive().default(5),
  logLimit: z.number().int().positive().default(200),
  includeLogs: z.boolean().default(true),
});

export type ValidatedTaskPlan = z.infer<typeof taskPlanSchema>;
export type ValidatedHeadlessResult = z.infer<typeof headlessResultSchema>;
export type ValidatedSessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type WebConfig = z.infer<typeof webConfigSchema>;
