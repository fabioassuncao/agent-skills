import { describe, expect, it } from 'vitest';
import { classifyAttempt } from './escalation.js';

describe('the three failure classes', () => {
  it('never puts provider_down on the escalation ladder', () => {
    expect(
      classifyAttempt({
        results: [],
        failureKind: 'provider_down',
      }),
    ).toBe('availability');
  });

  it('sends a missing binary to a human, never to a stronger model', () => {
    expect(
      classifyAttempt({
        results: [
          {
            id: 'test',
            command: 'npm test',
            status: 'could-not-run',
            fatal: true,
            durationMs: 1,
            exitCode: 127,
            output: 'command not found',
          },
        ],
      }),
    ).toBe('environment');
  });

  it('keeps a red check that ran as non-convergence', () => {
    expect(
      classifyAttempt({
        results: [
          {
            id: 'test',
            command: 'npm test',
            status: 'failed',
            fatal: true,
            durationMs: 40,
            exitCode: 1,
            output: 'Tests  3 failed',
          },
        ],
      }),
    ).toBe('non-convergence');
  });
});
