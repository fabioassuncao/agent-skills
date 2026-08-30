import type { ModelTier } from './models.js';
import { priorFor } from './priors.js';
import type { Candidate, RoutingProfile, TaskClass } from './types.js';

export const DELTA = 0.2;
export const MIN_SAMPLE_SIZE = 8;

export const PROFILE_WEIGHTS: Record<
  RoutingProfile,
  { quality: number; cost: number; latency: number }
> = {
  economy: { quality: 0.5, cost: 0.4, latency: 0.1 },
  balanced: { quality: 0.6, cost: 0.25, latency: 0.15 },
  quality: { quality: 0.85, cost: 0.05, latency: 0.1 },
  speed: { quality: 0.45, cost: 0.1, latency: 0.45 },
};

export interface ScoreInput {
  harness: string;
  provider: string;
  model?: string | null;
  tier: ModelTier;
  relativeCost: number;
  relativeLatency: number;
  eligible: boolean;
  reasonCodes: string[];
  taskClass: TaskClass;
  learned?: number;
  samples?: number;
  profile?: RoutingProfile;
  /** Observed cost status from #78; catalog-relative cost is always available. */
  costStatus?: 'reported' | 'estimated' | 'unknown';
}

export function clampLearned(value: number): number {
  return Math.max(-DELTA, Math.min(DELTA, value));
}

export function scoreCandidates(inputs: readonly ScoreInput[]): Candidate[] {
  const profile = inputs[0]?.profile ?? 'balanced';
  const scored: Candidate[] = inputs.map((input) => {
    const prior = priorFor(input.taskClass, input.harness, input.tier);
    const samples = input.samples ?? 0;
    const rawLearned = samples >= MIN_SAMPLE_SIZE ? (input.learned ?? 0) : 0;
    const learned = clampLearned(rawLearned);
    const weights = PROFILE_WEIGHTS[profile];
    // This is catalog-relative ordering, not observed USD. An unknown reported
    // cost still contributes no measured-cost signal; the declared tier order
    // remains available to economy/balanced profiles.
    const costScore = 1 / input.relativeCost;
    const latencyScore = 1 / input.relativeLatency;
    const score = input.eligible
      ? (prior + learned) * weights.quality +
        costScore * weights.cost +
        latencyScore * weights.latency
      : 0;
    const reasonCodes = [...input.reasonCodes];
    if (input.eligible && samples === 0) reasonCodes.push('COLD_START');
    if (input.eligible && learned > 0) reasonCodes.push('HIGH_HISTORICAL_SUCCESS');
    return {
      harness: input.harness,
      provider: input.provider,
      model: input.model ?? null,
      tier: input.tier,
      relativeCost: input.relativeCost,
      relativeLatency: input.relativeLatency,
      eligible: input.eligible,
      prior,
      learned,
      samples,
      score,
      reasonCodes,
    };
  });

  return scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.harness.localeCompare(b.harness);
  });
}

export function pickSelected(candidates: readonly Candidate[]): Candidate {
  const eligible = candidates.filter((candidate) => candidate.eligible);
  if (eligible.length === 0) {
    throw new Error(
      `No eligible routing candidate: ${candidates.map((c) => `${c.harness} (${c.reasonCodes.join(',')})`).join('; ')}`,
    );
  }
  return eligible[0] as Candidate;
}
