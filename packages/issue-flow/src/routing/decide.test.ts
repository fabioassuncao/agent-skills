import { describe, expect, it } from 'vitest';
import { decideRouting } from './decide.js';

describe('decideRouting', () => {
  it('records selected and actual in shadow and changes nothing', () => {
    const decision = decideRouting({
      signals: { title: 'Fix crash on empty input' },
      phase: 'execute',
      actualHarness: 'claude-code',
      mode: 'shadow',
    });
    expect(decision?.mode).toBe('shadow');
    expect(decision?.actual).toBe('claude-code');
    expect(decision?.selected).toBeTruthy();
    expect(decision?.candidates.length).toBeGreaterThan(0);
  });

  it('records nothing when mode is off', () => {
    expect(
      decideRouting({
        phase: 'execute',
        actualHarness: 'claude-code',
        mode: 'off',
      }),
    ).toBeNull();
  });

  it('skips the score when the phase is explicitly configured', () => {
    const decision = decideRouting({
      phase: 'execute',
      actualHarness: 'claude-code',
      mode: 'shadow',
      skipScore: true,
    });
    expect(decision?.reasonCodes).toContain('EXPLICIT_CONFIG');
    expect(decision?.selected).toBe('claude-code');
    expect(decision?.candidates).toEqual([]);
  });
});
