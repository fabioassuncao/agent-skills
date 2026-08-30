import { describe, expect, it } from 'vitest';
import { readinessFixture } from '../agents/availability.js';
import { CURSOR_CAPABILITIES } from '../agents/types.js';
import { filterEligible } from './capabilities.js';

describe('filterEligible', () => {
  it('marks a harness without extraDirectories ineligible when addDirs are required', () => {
    const none = {
      ...CURSOR_CAPABILITIES,
      extraDirectories: 'none' as const,
      addDirs: false,
    };
    const result = filterEligible({
      harness: 'other',
      capabilities: none,
      phase: 'execute',
      requiresExtraDirectories: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasonCodes[0]).toMatch(/extraDirectories/);
  });

  it('ignores a missing tool allowlist', () => {
    const result = filterEligible({
      harness: 'codex-cli',
      capabilities: { ...CURSOR_CAPABILITIES, toolAllowlist: false },
      phase: 'review',
      requiresExtraDirectories: false,
    });
    expect(result.eligible).toBe(true);
  });

  it('excludes providers that are not installed', () => {
    const snapshot = readinessFixture({
      codex: { installed: false, authentication: 'failed', state: 'unavailable' },
    });
    const result = filterEligible({
      harness: 'codex-cli',
      capabilities: CURSOR_CAPABILITIES,
      phase: 'plan',
      requiresExtraDirectories: false,
      readiness: snapshot.providers.codex,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasonCodes).toContain('PROVIDER_NOT_INSTALLED');
  });

  it('keeps authProbe:none providers eligible as conditional', () => {
    const snapshot = readinessFixture({
      antigravity: {
        installed: true,
        authentication: 'unverified',
        state: 'conditional',
      },
    });
    const result = filterEligible({
      harness: 'antigravity-cli',
      capabilities: CURSOR_CAPABILITIES,
      phase: 'execute',
      requiresExtraDirectories: false,
      readiness: snapshot.providers.antigravity,
    });
    expect(result.eligible).toBe(true);
    expect(result.reasonCodes).toContain('AUTHENTICATION_UNVERIFIED');
    expect(result.reasonCodes).toContain('READINESS_CONDITIONAL');
  });

  it('excludes providers in cooldown', () => {
    const snapshot = readinessFixture({
      cursor: {
        installed: true,
        authentication: 'confirmed',
        state: 'unavailable',
        cooldownUntil: '2026-08-30T13:00:00.000Z',
        observedAt: '2026-08-30T12:00:00.000Z',
      },
    });
    const result = filterEligible({
      harness: 'cursor-cli',
      capabilities: CURSOR_CAPABILITIES,
      phase: 'execute',
      requiresExtraDirectories: false,
      readiness: snapshot.providers.cursor,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasonCodes).toContain('PROVIDER_COOLDOWN');
  });
});
