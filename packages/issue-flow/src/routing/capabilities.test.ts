import { describe, expect, it } from 'vitest';
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
});
