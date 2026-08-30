import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../verify/types.js';
import {
  classifyAttempt,
  detectNonConvergence,
  failureFingerprint,
  nextModelTier,
  nextRung,
  unusedHarness,
} from './escalation.js';

function check(id: string, status: CheckResult['status'], output = 'failed'): CheckResult {
  return {
    id,
    command: `npm run ${id}`,
    status,
    fatal: true,
    durationMs: 10,
    exitCode: status === 'failed' ? 1 : status === 'could-not-run' ? 127 : 0,
    output,
  };
}

describe('classifyAttempt', () => {
  it('treats a check that could not run as environment', () => {
    expect(
      classifyAttempt({
        results: [check('test', 'could-not-run', 'ENOENT: npm')],
      }),
    ).toBe('environment');
  });

  it('treats a check that ran and failed as non-convergence', () => {
    expect(classifyAttempt({ results: [check('test', 'failed', '3 failing tests')] })).toBe(
      'non-convergence',
    );
  });

  it('keeps provider_down on the availability path', () => {
    expect(
      classifyAttempt({
        results: [check('test', 'failed')],
        failureKind: 'provider_down',
      }),
    ).toBe('availability');
  });
});

describe('nextModelTier', () => {
  const catalog = [
    { id: 'fast', tier: 'fast' as const, relativeCost: 1, relativeLatency: 1 },
    { id: 'mid', tier: 'mid' as const, relativeCost: 2, relativeLatency: 2 },
    { id: 'strong', tier: 'strong' as const, relativeCost: 3, relativeLatency: 3 },
  ];

  it('returns a concrete stronger target and never repeats a tried tier', () => {
    expect(nextModelTier('fast', [], catalog)?.id).toBe('mid');
    expect(nextModelTier('fast', ['mid'], catalog)?.id).toBe('strong');
    expect(nextModelTier('mid', ['strong'], catalog)).toBeNull();
  });
});

describe('detectNonConvergence', () => {
  it('does not escalate when fatal failures drop or the diff grows', () => {
    expect(
      detectNonConvergence({
        minAttempts: 2,
        history: [
          { fingerprint: 'a', fatalFailed: 40, diffBytes: 10 },
          { fingerprint: 'b', fatalFailed: 2, diffBytes: 10 },
        ],
      }),
    ).toEqual({ nonConverged: false, reason: 'progress' });

    expect(
      detectNonConvergence({
        minAttempts: 2,
        history: [
          { fingerprint: 'a', fatalFailed: 3, diffBytes: 10 },
          { fingerprint: 'a', fatalFailed: 3, diffBytes: 80 },
        ],
      }),
    ).toEqual({ nonConverged: false, reason: 'progress' });
  });

  it('escalates on a repeated fingerprint and ignores error text', () => {
    const first = failureFingerprint([check('test', 'failed', 'expected 1')]);
    const second = failureFingerprint([
      check('test', 'failed', 'expected 99 — completely different'),
    ]);
    expect(first).toBe(second);
    expect(first).toBe('test');

    expect(
      detectNonConvergence({
        minAttempts: 2,
        history: [
          { fingerprint: first, fatalFailed: 1 },
          { fingerprint: second, fatalFailed: 1 },
        ],
      }),
    ).toEqual({ nonConverged: true, reason: 'repeated-fingerprint' });
  });
});

describe('nextRung', () => {
  const caps = { reasoningEffort: true, modelSelection: true, otherHarness: true };

  it('only climbs and never returns a tried rung', () => {
    const first = nextRung({ tried: ['current'], capabilities: caps, maxEscalations: 5 });
    expect(first.rung).toBe('effort');
    const second = nextRung({
      tried: ['current', 'effort'],
      capabilities: caps,
      maxEscalations: 5,
    });
    expect(second.rung).toBe('model');
    const third = nextRung({
      tried: ['current', 'effort', 'model'],
      capabilities: caps,
      maxEscalations: 5,
    });
    expect(third.rung).toBe('harness');
    expect(third.rung).not.toBe('effort');
  });

  it('makes claude → codex → claude impossible', () => {
    expect(unusedHarness('claude', [], ['claude', 'codex', 'cursor'])).toBe('codex');
    expect(unusedHarness('codex', ['claude'], ['claude', 'codex', 'cursor'])).toBe('cursor');
    expect(unusedHarness('cursor', ['claude', 'codex'], ['claude', 'codex', 'cursor'])).toBeNull();
  });

  it('skips a rung the harness cannot do', () => {
    const result = nextRung({
      tried: ['current'],
      capabilities: { reasoningEffort: false, modelSelection: false, otherHarness: true },
    });
    expect(result.rung).toBe('harness');
    expect(result.skipped).toEqual(['effort', 'model']);
  });

  it('respects maxEscalations and then blocks', () => {
    const result = nextRung({
      tried: ['current', 'effort'],
      capabilities: caps,
      maxEscalations: 1,
      escalationsUsed: 1,
    });
    expect(result.rung).toBe('blocked');
    expect(result.exhausted).toBe(true);
  });
});
