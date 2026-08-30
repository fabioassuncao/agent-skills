import { z } from 'zod';
import { AGENT_PHASES, type AgentPhase } from './types.js';

/**
 * File-format schemas for the `agent` key.
 *
 * These are intermediate layers (global `config.json` and `.issue-flow.json`).
 * No field carries a `.default()`: a default materialized here would look
 * like a value the user wrote and would silently override the rung above.
 */

export const agentProviderIdSchema = z.enum(['claude', 'codex', 'cursor', 'antigravity']);

export const codexSandboxSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);

export const codexReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']);

export const claudeSettingsSchema = z
  .object({
    ignoreUserConfig: z.boolean(),
    strictMcpConfig: z.boolean(),
  })
  .partial();

export const codexSettingsSchema = z
  .object({
    reasoningEffort: codexReasoningEffortSchema,
    sandbox: codexSandboxSchema,
    ignoreUserConfig: z.boolean(),
    skipGitRepoCheck: z.boolean(),
    configOverrides: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  })
  .partial();

export const cursorSandboxSchema = z.enum(['enabled', 'disabled']);

export const cursorPermissionsFileSchema = z.enum(['global', 'project', 'none']);

export const cursorSettingsSchema = z
  .object({
    sandbox: cursorSandboxSchema,
    approveMcps: z.boolean(),
    permissionsFile: cursorPermissionsFileSchema,
    minVersion: z.string().min(1),
    force: z.boolean().refine((value) => value !== false, {
      message:
        'agent.cursor.force cannot be false: without --force, Cursor finishes with exit 0 and writes nothing.',
    }),
  })
  .partial();

export const antigravityEffortSchema = z.enum(['low', 'medium', 'high']);

export const antigravitySettingsSchema = z
  .object({
    effort: antigravityEffortSchema,
    sandbox: z.boolean(),
    executeTimeout: z.union([z.number().int(), z.string().min(1), z.null()]),
    maxPromptBytes: z.number().int().positive(),
    minVersion: z.string().min(1),
    skipPermissions: z.boolean().refine((value) => value !== false, {
      message:
        'agent.antigravity.skipPermissions cannot be false: without --dangerously-skip-permissions, Antigravity finishes SUCCESS and writes nothing.',
    }),
  })
  .partial();

export const agentBlockSchema = z
  .object({
    provider: agentProviderIdSchema,
    model: z.string().min(1).nullable(),
    claude: claudeSettingsSchema,
    codex: codexSettingsSchema,
    cursor: cursorSettingsSchema,
    antigravity: antigravitySettingsSchema,
  })
  .partial();

/**
 * The `phases` map as written in a file. Unknown keys are dropped by the
 * loader (with a warning); this schema only accepts the eight real phases.
 */
export const agentPhasesSchema = z
  .object({
    analyze: agentBlockSchema,
    generate: agentBlockSchema,
    prd: agentBlockSchema,
    plan: agentBlockSchema,
    execute: agentBlockSchema,
    review: agentBlockSchema,
    pr: agentBlockSchema,
    'pr-review': agentBlockSchema,
  })
  .partial();

/** Input shape of the `agent` key — every field optional, no defaults. */
export const agentConfigInputSchema = z
  .object({
    provider: agentProviderIdSchema,
    model: z.string().min(1).nullable(),
    claude: claudeSettingsSchema,
    codex: codexSettingsSchema,
    cursor: cursorSettingsSchema,
    antigravity: antigravitySettingsSchema,
    phases: agentPhasesSchema,
  })
  .partial();

export type AgentConfigInput = z.infer<typeof agentConfigInputSchema>;

/** Loose parse of a `phases` object so unknown keys can be reported. */
export function parsePhasesInput(
  value: unknown,
  warn: (message: string) => void,
): Partial<Record<AgentPhase, z.infer<typeof agentBlockSchema>>> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    warn('Ignoring "agent.phases": expected an object.');
    return {};
  }

  const result: Partial<Record<AgentPhase, z.infer<typeof agentBlockSchema>>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(AGENT_PHASES as readonly string[]).includes(key)) {
      warn(`Ignoring unknown agent phase "${key}".`);
      continue;
    }
    const parsed = agentBlockSchema.safeParse(raw);
    if (!parsed.success) {
      warn(`Ignoring agent.phases.${key}: ${parsed.error.issues[0]?.message ?? 'invalid value'}.`);
      continue;
    }
    result[key as AgentPhase] = parsed.data;
  }
  return result;
}
