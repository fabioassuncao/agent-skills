import type { ModelTier } from './models.js';
import type { TaskClass } from './types.js';

/** Bump when a cell's provenance changes. */
export const PRIORS_VERSION = '2';

/**
 * Cold-start priors. Provenance: author judgement on 2026-08-30 from the
 * #79 baseline and the #76 capability matrix — not measured affinity.
 */
type HarnessPriors = Record<string, Record<ModelTier, number>>;

function tiers(mid: number): Record<ModelTier, number> {
  return { fast: Math.max(0, mid - 0.25), mid, strong: Math.min(1, mid + 0.12) };
}

function harnesses(values: Record<string, number>): HarnessPriors {
  return Object.fromEntries(Object.entries(values).map(([harness, mid]) => [harness, tiers(mid)]));
}

export const PRIORS: Record<TaskClass, HarnessPriors> = {
  bugfix: harnesses({
    'claude-code': 0.7,
    'codex-cli': 0.95,
    'cursor-cli': 0.65,
    'antigravity-cli': 0.6,
  }),
  feature: harnesses({
    'claude-code': 0.85,
    'codex-cli': 0.8,
    'cursor-cli': 0.7,
    'antigravity-cli': 0.65,
  }),
  refactor: harnesses({
    'claude-code': 0.75,
    'codex-cli': 0.9,
    'cursor-cli': 0.65,
    'antigravity-cli': 0.6,
  }),
  docs: harnesses({
    'claude-code': 0.8,
    'codex-cli': 0.7,
    'cursor-cli': 0.75,
    'antigravity-cli': 0.7,
  }),
  test: harnesses({
    'claude-code': 0.7,
    'codex-cli': 0.9,
    'cursor-cli': 0.65,
    'antigravity-cli': 0.6,
  }),
  infra: harnesses({
    'claude-code': 0.8,
    'codex-cli': 0.75,
    'cursor-cli': 0.6,
    'antigravity-cli': 0.55,
  }),
  analysis: harnesses({
    'claude-code': 0.95,
    'codex-cli': 0.6,
    'cursor-cli': 0.7,
    'antigravity-cli': 0.65,
  }),
};

export function priorFor(taskClass: TaskClass, harness: string, tier: ModelTier): number {
  return PRIORS[taskClass][harness]?.[tier] ?? 0.5;
}
