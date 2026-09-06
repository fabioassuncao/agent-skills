import { describe, expect, it } from 'vitest';
import { buildEvidence } from './evidence.js';
import type { ContractRun } from './types.js';

describe('buildEvidence', () => {
  it('preserves structured findings and redacts their text before persistence', () => {
    const evidence = buildEvidence({ verdict: 'failed', level: 'L2', results: [] }, null, {
      status: 'failed',
      independence: 'harness-and-vendor',
      provider: 'codex',
      degraded: false,
      findings: [
        {
          file: 'src/auth.ts',
          line: 2,
          severity: 'error',
          category: 'bug',
          claim: 'Exposes password="samplecredential" and ghp_1234567890123456',
        },
      ],
    });
    expect(evidence.review?.findings[0]).toMatchObject({ file: 'src/auth.ts', line: 2 });
    expect(JSON.stringify(evidence)).not.toContain('samplecredential');
    expect(JSON.stringify(evidence)).not.toContain('ghp_1234567890123456');
  });
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
