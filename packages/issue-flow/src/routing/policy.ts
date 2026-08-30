import type { AgentPhase, AgentProviderId } from '../agents/types.js';
import { type ModelTier, modelForTier } from './models.js';
import type { ExecutionTarget } from './types.js';

export const RECOMMENDED_POLICY_VERSION = '1';

export interface RecommendedPolicyEntry {
  tier: ModelTier;
  preferHarness?: string;
}

/** The token-economy guidance from docs/agents.md, made executable and reviewable. */
export const RECOMMENDED_POLICY: Record<AgentPhase, RecommendedPolicyEntry> = {
  analyze: { tier: 'fast', preferHarness: 'codex-cli' },
  generate: { tier: 'mid', preferHarness: 'claude-code' },
  prd: { tier: 'mid', preferHarness: 'claude-code' },
  plan: { tier: 'fast', preferHarness: 'codex-cli' },
  execute: { tier: 'strong', preferHarness: 'claude-code' },
  review: { tier: 'strong', preferHarness: 'codex-cli' },
  pr: { tier: 'fast', preferHarness: 'codex-cli' },
  'pr-review': { tier: 'strong', preferHarness: 'codex-cli' },
};

const PROVIDERS: Record<string, AgentProviderId> = {
  'claude-code': 'claude',
  'codex-cli': 'codex',
  'cursor-cli': 'cursor',
  'antigravity-cli': 'antigravity',
};

export function recommendedFor(phase: AgentPhase): RecommendedPolicyEntry {
  return RECOMMENDED_POLICY[phase];
}

export function recommendedTarget(phase: AgentPhase): ExecutionTarget | null {
  const entry = recommendedFor(phase);
  if (entry.preferHarness === undefined) return null;
  const model = modelForTier(entry.preferHarness, entry.tier);
  const provider = PROVIDERS[entry.preferHarness];
  if (model === null || provider === undefined) return null;
  return { harness: entry.preferHarness, provider, model: model.id, tier: entry.tier };
}
