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
    expect(decision?.actual.harness).toBe('claude-code');
    expect(decision?.selected.model).toBeTruthy();
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
    expect(decision?.selected.harness).toBe('claude-code');
    expect(decision?.candidates).toEqual([]);
  });

  it('expands model-selecting harnesses into concrete tier candidates', () => {
    const decision = decideRouting({
      phase: 'plan',
      actualHarness: 'claude-code',
      mode: 'shadow',
    });
    const codex = decision?.candidates.filter((candidate) => candidate.harness === 'codex-cli');
    expect(codex).toHaveLength(3);
    expect(codex?.every((candidate) => candidate.model !== null)).toBe(true);
  });

  it('applies the recommended phase tier before scoring', () => {
    const plan = decideRouting({
      phase: 'plan',
      actualHarness: 'claude-code',
      mode: 'active',
      policy: 'recommended',
    });
    expect(plan?.selected).toMatchObject({ harness: 'codex-cli', tier: 'fast' });
    expect(plan?.reasonCodes).toContain('RECOMMENDED_POLICY');
  });
});
