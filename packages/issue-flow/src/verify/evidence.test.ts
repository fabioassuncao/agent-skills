import { describe, expect, it } from 'vitest';
import { buildEvidence } from './evidence.js';
import type { ContractRun } from './types.js';

describe('buildEvidence', () => {
  it('keys the bundle by executionId', () => {
    const run: ContractRun = {
      verdict: 'unverified',
      level: 'L1',
      results: [],
    };
    expect(buildEvidence(run, 'abc').executionId).toBe('abc');
    expect(buildEvidence(run, null).executionId).toBeNull();
  });
});
