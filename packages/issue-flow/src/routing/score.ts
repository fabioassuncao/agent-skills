import { priorFor } from './priors.js';
import type { Candidate, RoutingProfile, TaskClass } from './types.js';

export const DELTA = 0.2;
export const MIN_SAMPLE_SIZE = 8;

const PROFILE_MULTIPLIER: Record<RoutingProfile, number> = {
  economy: 0.9,
  balanced: 1,
  quality: 1.05,
  speed: 1.02,
};

export interface ScoreInput {
  harness: string;
  provider: string;
  model?: string | null;
  eligible: boolean;
  reasonCodes: string[];
  taskClass: TaskClass;
  learned?: number;
  samples?: number;
  profile?: RoutingProfile;
  /** Cost status from #78. `unknown` never scores cost. */
  costStatus?: 'reported' | 'estimated' | 'unknown';
}

export function clampLearned(value: number): number {
  return Math.max(-DELTA, Math.min(DELTA, value));
}

export function scoreCandidates(inputs: readonly ScoreInput[]): Candidate[] {
  const profile = inputs[0]?.profile ?? 'balanced';
  const scored: Candidate[] = inputs.map((input) => {
    const prior = priorFor(input.taskClass, input.harness);
    const samples = input.samples ?? 0;
    const rawLearned = samples >= MIN_SAMPLE_SIZE ? (input.learned ?? 0) : 0;
    const learned = clampLearned(rawLearned);
    const multiplier = PROFILE_MULTIPLIER[profile];
    const score = input.eligible ? (prior + learned) * multiplier : 0;
    const reasonCodes = [...input.reasonCodes];
    if (input.eligible && samples === 0) reasonCodes.push('COLD_START');
    if (input.eligible && learned > 0) reasonCodes.push('HIGH_HISTORICAL_SUCCESS');
    if (input.costStatus === 'unknown') {
      // unknown (including subscription) is not $0 and does not score cost.
    }
    return {
      harness: input.harness,
      provider: input.provider,
      model: input.model ?? null,
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
