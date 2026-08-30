import { z } from 'zod';

/**
 * Zod schemas for the `policy` key of `.issue-flow.json`.
 *
 * Two shapes, and the difference matters:
 *
 * - {@link policyConfigInputSchema} validates what the user *wrote*, with no
 *   defaults materialized. It is what the file, env and CLI layers are parsed
 *   with, so an absent key stays absent and never shadows the layer below it
 *   (the caveat documented on `mergeConfigLayers`).
 * - {@link policyConfigSchema} is the resolved shape, with `enabled` and the
 *   discovery toggles filled in. The declarations stay optional there too:
 *   materializing them as `null` would make an unset `baseBranch` override the
 *   one discovery found.
 */

/** Which discovery passes run. Every one defaults to on. */
export const policyDiscoveryConfigSchema = z.object({
  issueTemplates: z.boolean().default(true),
  pullRequestTemplate: z.boolean().default(true),
  docs: z.boolean().default(true),
  codeowners: z.boolean().default(true),
  labels: z.boolean().default(true),
  issueTypes: z.boolean().default(true),
});

const policyIssuesDeclarationSchema = z.object({
  titleConvention: z.string().min(1).optional(),
  /**
   * Whether Issue Flow may create a label the repository does not have.
   *
   * `.optional()` rather than `.default(false)`: the resolved declarations must
   * stay "only what was written", or the group would always look declared and
   * `sources` would report a provenance nobody asked for. The effective default
   * — false — lives at the call site.
   *
   * That default is a deliberate change of behaviour: creating taxonomy without
   * asking is the defect this exists to stop. A repository that wants the old
   * behaviour opts back into it.
   */
  allowLabelCreation: z.boolean().optional(),
});

const policyPullRequestsDeclarationSchema = z.object({
  baseBranch: z.string().min(1).optional(),
  titleConvention: z.string().min(1).optional(),
});

const policyGitDeclarationSchema = z.object({
  branchConvention: z.string().min(1).optional(),
  commitConvention: z.string().min(1).optional(),
});

/**
 * Resolved policy configuration.
 *
 * `.prefault({})` rather than `.default({})`: in zod 4 a `.default()` value is
 * substituted *without* being parsed by the inner schema, so `discovery` would
 * come back as `{}` with none of its toggles filled in.
 */
export const policyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Token budget for the `__REPO_POLICY__` projection. Sections above it are
   * replaced whole by a pointer rather than truncated — see
   * `policy/placeholders.ts`.
   */
  contextBudget: z.number().int().positive().default(1500),
  discovery: policyDiscoveryConfigSchema.prefault({}),
  issues: policyIssuesDeclarationSchema.prefault({}),
  pullRequests: policyPullRequestsDeclarationSchema.prefault({}),
  git: policyGitDeclarationSchema.prefault({}),
});

/**
 * What the user may write. `.nullish()` on every declaration is deliberate:
 * `"baseBranch": null` is the natural way to spell "I do not declare this",
 * and the loader drops it instead of rejecting the whole key.
 */
export const policyConfigInputSchema = z.object({
  enabled: z.boolean().optional(),
  contextBudget: z.number().int().positive().optional(),
  // Spelled out rather than `policyDiscoveryConfigSchema.partial()`: in zod 4
  // a `.default()` survives `.partial()`, so every toggle would come back
  // materialized and the input layer would stop meaning "what the user wrote".
  discovery: z
    .object({
      issueTemplates: z.boolean().optional(),
      pullRequestTemplate: z.boolean().optional(),
      docs: z.boolean().optional(),
      codeowners: z.boolean().optional(),
      labels: z.boolean().optional(),
      issueTypes: z.boolean().optional(),
    })
    .optional(),
  issues: z
    .object({ titleConvention: z.string().nullish(), allowLabelCreation: z.boolean().optional() })
    .optional(),
  pullRequests: z
    .object({ baseBranch: z.string().nullish(), titleConvention: z.string().nullish() })
    .optional(),
  git: z
    .object({ branchConvention: z.string().nullish(), commitConvention: z.string().nullish() })
    .optional(),
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;
export type PolicyDiscoveryConfig = z.infer<typeof policyDiscoveryConfigSchema>;
export type PolicyConfigInput = z.infer<typeof policyConfigInputSchema>;
