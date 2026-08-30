import { describe, expect, it } from 'vitest';
import { AGENT_PHASES } from '../agents/types.js';
import { RECOMMENDED_POLICY, recommendedTarget } from './policy.js';

describe('recommended routing policy', () => {
  it('covers every agent phase', () => {
    expect(Object.keys(RECOMMENDED_POLICY).sort()).toEqual([...AGENT_PHASES].sort());
  });

  it('resolves plan and execute to concrete targets', () => {
    expect(recommendedTarget('plan')).toMatchObject({
      harness: 'codex-cli',
      provider: 'codex',
      tier: 'fast',
      model: expect.any(String),
    });
    expect(recommendedTarget('execute')).toMatchObject({
      harness: 'claude-code',
      provider: 'claude',
      tier: 'strong',
      model: expect.any(String),
    });
  });
});
