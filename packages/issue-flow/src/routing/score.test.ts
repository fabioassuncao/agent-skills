import { describe, expect, it } from 'vitest';
import { clampLearned, DELTA, MIN_SAMPLE_SIZE, pickSelected, scoreCandidates } from './score.js';

const base = {
  harness: 'codex-cli',
  provider: 'codex',
  eligible: true,
  reasonCodes: [] as string[],
  taskClass: 'bugfix' as const,
  tier: 'mid' as const,
  relativeCost: 3,
  relativeLatency: 1.5,
};

describe('scoreCandidates', () => {
  it('uses the declared prior with no learned history', () => {
    const [first] = scoreCandidates([base]);
    expect(first?.learned).toBe(0);
    expect(first?.score).toBeGreaterThan(0);
    expect(first?.reasonCodes).toContain('COLD_START');
  });

  it('clamps learned to ±DELTA', () => {
    expect(clampLearned(1)).toBe(DELTA);
    expect(clampLearned(-1)).toBe(-DELTA);
    const [first] = scoreCandidates([{ ...base, learned: 4, samples: MIN_SAMPLE_SIZE }]);
    expect(first?.learned).toBe(DELTA);
  });

  it('ignores learned below minSampleSize', () => {
    const [first] = scoreCandidates([{ ...base, learned: 0.15, samples: 2 }]);
    expect(first?.learned).toBe(0);
  });

  it('does not treat unknown cost as zero', () => {
    const [first] = scoreCandidates([{ ...base, costStatus: 'unknown' }]);
    expect(first?.score).toBeCloseTo((first?.prior ?? 0) * 0.6 + 0.1);
  });

  it('breaks ties by harness name', () => {
    const ranked = scoreCandidates([
      { ...base, harness: 'cursor-cli', provider: 'cursor' },
      { ...base, harness: 'claude-code', provider: 'claude' },
    ]);
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(ranked[1]?.score ?? 0);
  });

  it('throws when nothing is eligible', () => {
    expect(() =>
      pickSelected([
        {
          harness: 'cursor-cli',
          provider: 'cursor',
          model: null,
          tier: 'mid',
          relativeCost: 1,
          relativeLatency: 1,
          eligible: false,
          prior: 0.5,
          learned: 0,
          samples: 0,
          score: 0,
          reasonCodes: ['MISSING_CAPABILITY:extraDirectories'],
        },
      ]),
    ).toThrow(/No eligible/);
  });

  it('lets profiles select the intended cost/quality tier', () => {
    const candidates = (profile: 'economy' | 'quality') =>
      scoreCandidates(
        (['fast', 'mid', 'strong'] as const).map((tier, index) => ({
          ...base,
          model: tier,
          tier,
          relativeCost: [1, 3.5, 8][index] as number,
          relativeLatency: [1, 1.5, 2.2][index] as number,
          taskClass: 'feature' as const,
          profile,
          costStatus: 'reported' as const,
        })),
      );
    expect(candidates('economy')[0]?.tier).toBe('fast');
    expect(candidates('quality')[0]?.tier).toBe('strong');
  });
});
