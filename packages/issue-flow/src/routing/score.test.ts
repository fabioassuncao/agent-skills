import { describe, expect, it } from 'vitest';
import { clampLearned, DELTA, MIN_SAMPLE_SIZE, pickSelected, scoreCandidates } from './score.js';

describe('scoreCandidates', () => {
  it('is exactly the prior with no history', () => {
    const [first] = scoreCandidates([
      {
        harness: 'codex-cli',
        provider: 'codex',
        eligible: true,
        reasonCodes: [],
        taskClass: 'bugfix',
      },
    ]);
    expect(first?.learned).toBe(0);
    expect(first?.score).toBe(first?.prior);
    expect(first?.reasonCodes).toContain('COLD_START');
  });

  it('clamps learned to ±DELTA', () => {
    expect(clampLearned(1)).toBe(DELTA);
    expect(clampLearned(-1)).toBe(-DELTA);
    const [first] = scoreCandidates([
      {
        harness: 'codex-cli',
        provider: 'codex',
        eligible: true,
        reasonCodes: [],
        taskClass: 'bugfix',
        learned: 4,
        samples: MIN_SAMPLE_SIZE,
      },
    ]);
    expect(first?.learned).toBe(DELTA);
  });

  it('ignores learned below minSampleSize', () => {
    const [first] = scoreCandidates([
      {
        harness: 'codex-cli',
        provider: 'codex',
        eligible: true,
        reasonCodes: [],
        taskClass: 'bugfix',
        learned: 0.15,
        samples: 2,
      },
    ]);
    expect(first?.learned).toBe(0);
  });

  it('does not treat unknown cost as zero', () => {
    const [first] = scoreCandidates([
      {
        harness: 'claude-code',
        provider: 'claude',
        eligible: true,
        reasonCodes: [],
        taskClass: 'docs',
        costStatus: 'unknown',
      },
    ]);
    expect(first?.score).toBe(first?.prior);
  });

  it('breaks ties by harness name', () => {
    const ranked = scoreCandidates([
      {
        harness: 'cursor-cli',
        provider: 'cursor',
        eligible: true,
        reasonCodes: [],
        taskClass: 'docs',
      },
      {
        harness: 'claude-code',
        provider: 'claude',
        eligible: true,
        reasonCodes: [],
        taskClass: 'docs',
      },
    ]);
    expect(ranked[0]?.harness < ranked[1]?.harness || ranked[0]?.score >= ranked[1]?.score).toBe(
      true,
    );
  });

  it('throws when nothing is eligible', () => {
    expect(() =>
      pickSelected([
        {
          harness: 'cursor-cli',
          provider: 'cursor',
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
});
