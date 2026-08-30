import { describe, expect, it } from 'vitest';
import { createInitialSnapshot, reduceSessionEvent } from '../core/session-state.js';
import { renderStatusView } from '../ui/status-view.js';
import { formatVerificationLine } from './present.js';
import { verdictFromResults } from './runner.js';
import type { CheckResult } from './types.js';

function result(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    id: 'test',
    command: 'npm test',
    status: 'passed',
    fatal: true,
    durationMs: 1,
    exitCode: 0,
    output: '',
    ...overrides,
  };
}

describe('three verdicts', () => {
  it('covers passed, failed and unverified', () => {
    expect(verdictFromResults([result()])).toBe('passed');
    expect(verdictFromResults([result({ status: 'failed' })])).toBe('failed');
    expect(verdictFromResults([])).toBe('unverified');
  });

  it('never presents unverified as verified success', () => {
    expect(formatVerificationLine('unverified', 'L1')).toMatch(/unverified/);
    expect(formatVerificationLine('unverified', 'L1')).not.toMatch(/passed|verified success/i);
    expect(formatVerificationLine('passed', 'L1')).toMatch(/passed/);
  });

  it('propagates unverified onto the session snapshot', () => {
    const next = reduceSessionEvent(createInitialSnapshot(), {
      type: 'verify:end',
      at: '2026-08-30T00:00:00.000Z',
      verdict: 'unverified',
      level: 'L1',
      independence: null,
      executionId: null,
    });
    expect(next.verification?.verdict).toBe('unverified');
    const view = renderStatusView(next).join('\n');
    expect(view).toMatch(/unverified/);
    expect(view).not.toMatch(/verified success/i);
  });
});
