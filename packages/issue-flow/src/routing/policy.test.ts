import { describe, expect, it } from 'vitest';
import { AGENT_PHASES } from '../agents/types.js';
import { RECOMMENDED_POLICY, recommendedTarget } from './policy.js';

describe('recommended routing policy', () => {
  it('covers every agent phase with objectives, not hard pins', () => {
    expect(Object.keys(RECOMMENDED_POLICY).sort()).toEqual([...AGENT_PHASES].sort());
    for (const entry of Object.values(RECOMMENDED_POLICY)) {
      expect(entry.preferredTier).toMatch(/fast|mid|strong/);
      expect(entry.optimizeFor).toBeTruthy();
      expect('preferHarness' in entry).toBe(false);
    }
  });

  it('resolves affinity targets for explain without requiring them at runtime', () => {
    expect(recommendedTarget('plan')).toMatchObject({
      harness: 'codex-cli',
      provider: 'codex',
      tier: 'fast',
      model: expect.any(String),
    });
    expect(recommendedTarget('execute')).toMatchObject({
      harness: 'claude-code',
      provider: 'claude',
      tier: 'mid',
      model: expect.any(String),
    });
  });
});
