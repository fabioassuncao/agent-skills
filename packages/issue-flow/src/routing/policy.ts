import type { AgentPhase, AgentProviderId } from '../agents/types.js';
import { type ModelTier, modelForTier } from './models.js';
import type { ExecutionTarget } from './types.js';

export const RECOMMENDED_POLICY_VERSION = '2';

export type OptimizeFor = 'cost-speed' | 'time-to-correct' | 'quality' | 'balanced';

/**
 * Phase objectives for the opinionated policy. Affinity is a soft prior /
 * tie-break — never an eligibility filter that eliminates other harnesses.
 */
export interface RecommendedPolicyEntry {
  preferredTier: ModelTier;
  optimizeFor: OptimizeFor;
  escalateTo?: ModelTier;
  independentFrom?: AgentPhase;
  /** When true (default), conditional providers may win if no ready peer exists. */
  allowConditional?: boolean;
  /** Soft harness affinity for scoring — not a hard pin. */
  affinityHarness?: string;
}

/** The token-economy guidance from docs/agents.md, made executable and reviewable. */
export const RECOMMENDED_POLICY: Record<AgentPhase, RecommendedPolicyEntry> = {
  analyze: {
    preferredTier: 'fast',
    optimizeFor: 'cost-speed',
    affinityHarness: 'codex-cli',
  },
  generate: {
    preferredTier: 'mid',
    optimizeFor: 'balanced',
    affinityHarness: 'claude-code',
  },
  prd: {
    preferredTier: 'mid',
    optimizeFor: 'balanced',
    affinityHarness: 'claude-code',
  },
  plan: {
    preferredTier: 'fast',
    optimizeFor: 'cost-speed',
    affinityHarness: 'codex-cli',
  },
  execute: {
    preferredTier: 'mid',
    escalateTo: 'strong',
    optimizeFor: 'time-to-correct',
    affinityHarness: 'claude-code',
  },
  review: {
    preferredTier: 'strong',
    optimizeFor: 'quality',
    independentFrom: 'execute',
    affinityHarness: 'codex-cli',
  },
  pr: {
    preferredTier: 'fast',
    optimizeFor: 'cost-speed',
    affinityHarness: 'codex-cli',
  },
  'pr-review': {
    preferredTier: 'strong',
    optimizeFor: 'quality',
    affinityHarness: 'codex-cli',
  },
};

const PROVIDERS: Record<string, AgentProviderId> = {
  'claude-code': 'claude',
  'codex-cli': 'codex',
  'cursor-cli': 'cursor',
  'antigravity-cli': 'antigravity',
  'opencode-cli': 'opencode',
};

export function recommendedFor(phase: AgentPhase): RecommendedPolicyEntry {
  return RECOMMENDED_POLICY[phase];
}

/**
 * Illustrative affinity target for `routing explain`. The live decision may
 * pick a different harness when readiness or score says so.
 */
export function recommendedTarget(phase: AgentPhase): ExecutionTarget | null {
  const entry = recommendedFor(phase);
  const harness = entry.affinityHarness;
  if (harness === undefined) return null;
  const model = modelForTier(harness, entry.preferredTier);
  const provider = PROVIDERS[harness];
  if (model === null || provider === undefined) return null;
  return { harness, provider, model: model.id, tier: entry.preferredTier };
}
