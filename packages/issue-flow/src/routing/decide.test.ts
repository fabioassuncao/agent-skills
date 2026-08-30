import { describe, expect, it } from 'vitest';
import { readinessFixture } from '../agents/availability.js';
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

  it('soft-prefers affinity without pinning when readiness is absent', () => {
    const plan = decideRouting({
      phase: 'plan',
      actualHarness: 'claude-code',
      mode: 'active',
      policy: 'recommended',
    });
    expect(plan?.selected.tier).toBe('fast');
    expect(plan?.reasonCodes).toContain('RECOMMENDED_POLICY');
    // Affinity still wins when every harness looks equally ready.
    expect(plan?.selected.harness).toBe('codex-cli');
  });

  it('uses the only ready harness for every phase', () => {
    const readiness = readinessFixture({
      claude: { installed: true, authentication: 'unverified', state: 'conditional' },
      codex: { installed: false, authentication: 'failed', state: 'unavailable' },
      cursor: { installed: false, authentication: 'failed', state: 'unavailable' },
      antigravity: { installed: false, authentication: 'failed', state: 'unavailable' },
    });
    for (const phase of ['plan', 'execute', 'review'] as const) {
      const decision = decideRouting({
        phase,
        actualHarness: 'claude-code',
        mode: 'active',
        policy: 'recommended',
        readiness,
      });
      expect(decision?.selected.harness).toBe('claude-code');
      expect(decision?.candidates.every((c) => c.harness !== 'claude-code' || c.eligible)).toBe(
        true,
      );
      expect(
        decision?.candidates.filter((c) => c.harness !== 'claude-code').every((c) => !c.eligible),
      ).toBe(true);
    }
  });

  it('never selects a provider with failed authentication', () => {
    const readiness = readinessFixture({
      claude: { installed: true, authentication: 'failed', state: 'unavailable' },
      codex: { installed: true, authentication: 'confirmed', state: 'ready' },
      cursor: { installed: false, authentication: 'failed', state: 'unavailable' },
      antigravity: { installed: false, authentication: 'failed', state: 'unavailable' },
    });
    const decision = decideRouting({
      phase: 'execute',
      actualHarness: 'claude-code',
      mode: 'active',
      policy: 'recommended',
      readiness,
    });
    expect(decision?.selected.harness).toBe('codex-cli');
    expect(
      decision?.candidates.filter((c) => c.harness === 'claude-code').every((c) => !c.eligible),
    ).toBe(true);
  });

  it('allows Antigravity as the sole conditional candidate', () => {
    const readiness = readinessFixture({
      claude: { installed: false, authentication: 'failed', state: 'unavailable' },
      codex: { installed: false, authentication: 'failed', state: 'unavailable' },
      cursor: { installed: false, authentication: 'failed', state: 'unavailable' },
      antigravity: { installed: true, authentication: 'unverified', state: 'conditional' },
    });
    const decision = decideRouting({
      phase: 'execute',
      actualHarness: 'claude-code',
      mode: 'active',
      policy: 'recommended',
      readiness,
    });
    expect(decision?.selected.harness).toBe('antigravity-cli');
    expect(decision?.reasonCodes).toContain('AUTHENTICATION_UNVERIFIED');
  });

  it('ranks confirmed peers ahead of conditional ones', () => {
    const readiness = readinessFixture({
      claude: { installed: true, authentication: 'unverified', state: 'conditional' },
      codex: { installed: true, authentication: 'confirmed', state: 'ready' },
      cursor: { installed: false, authentication: 'failed', state: 'unavailable' },
      antigravity: { installed: false, authentication: 'failed', state: 'unavailable' },
    });
    const decision = decideRouting({
      phase: 'plan',
      actualHarness: 'claude-code',
      mode: 'active',
      policy: 'recommended',
      readiness,
    });
    expect(decision?.selected.harness).toBe('codex-cli');
    const claude = decision?.candidates.find((c) => c.harness === 'claude-code' && c.eligible);
    const codex = decision?.candidates.find((c) => c.harness === 'codex-cli' && c.eligible);
    expect(codex?.score ?? 0).toBeGreaterThan(claude?.score ?? 0);
  });
});
