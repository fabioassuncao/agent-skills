import { describe, expect, it } from 'vitest';
import type { RoutingDecision } from '../routing/types.js';
import type { AgentAvailability } from './availability.js';
import { applyRoutingDecision, routingRecommendationLine } from './routing-application.js';
import type { AgentSelection } from './select.js';

const selection: AgentSelection = {
  primary: 'claude',
  provider: 'claude',
  settings: {
    provider: 'claude',
    model: null,
    claude: {},
    codex: {},
    cursor: {},
    antigravity: {},
    opencode: {},
    origin: { provider: 'default', model: 'default' },
  },
  health: null,
  failover: false,
  reason: null,
  cooldownUntil: null,
};

function availability(
  id: 'claude' | 'codex' | 'cursor' | 'antigravity' | 'opencode',
  patch: Partial<AgentAvailability> = {},
): AgentAvailability {
  return {
    id,
    installed: true,
    authentication: 'confirmed',
    state: 'ready',
    version: 'test',
    detail: 'test',
    observedAt: '2026-08-30T12:00:00.000Z',
    expiresAt: '2026-08-30T12:05:00.000Z',
    source: 'probe',
    cooldownUntil: null,
    ...patch,
  };
}

const decision: RoutingDecision = {
  policyVersion: '2',
  profile: 'balanced',
  taskClass: 'feature',
  risk: 'medium',
  mode: 'active',
  candidates: [
    {
      harness: 'codex-cli',
      provider: 'codex',
      model: 'gpt-5.6-luna',
      tier: 'fast',
      relativeCost: 1,
      relativeLatency: 1,
      eligible: true,
      prior: 0.5,
      learned: 0,
      samples: 0,
      score: 0.9,
      reasonCodes: [],
    },
    {
      harness: 'claude-code',
      provider: 'claude',
      model: 'claude-sonnet-4-20250514',
      tier: 'mid',
      relativeCost: 2,
      relativeLatency: 1.2,
      eligible: true,
      prior: 0.5,
      learned: 0,
      samples: 0,
      score: 0.7,
      reasonCodes: [],
    },
  ],
  selected: {
    harness: 'codex-cli',
    provider: 'codex',
    model: 'gpt-5.6-luna',
    tier: 'fast',
  },
  actual: { harness: 'claude-code', provider: 'claude', model: null },
  reasonCodes: [],
};

describe('applyRoutingDecision', () => {
  it('formats recommend output without changing the selection', async () => {
    const recommend = { ...decision, mode: 'recommend' as const };
    expect(routingRecommendationLine(recommend, 'plan')).toContain(
      'Routing suggests codex:gpt-5.6-luna (fast) for plan',
    );
    const result = await applyRoutingDecision(selection, recommend, 'plan', {
      probe: async (id) => availability(id),
    });
    expect(result.selection).toBe(selection);
  });

  it('changes provider and concrete model only in active mode', async () => {
    const result = await applyRoutingDecision(selection, decision, 'plan', {
      probe: async (id) => availability(id),
    });
    expect(result.applied).toBe(true);
    expect(result.selection.provider).toBe('codex');
    expect(result.selection.settings.model).toBe('gpt-5.6-luna');

    const shadow = await applyRoutingDecision(selection, { ...decision, mode: 'shadow' }, 'plan', {
      probe: async (id) => availability(id),
    });
    expect(shadow.selection).toBe(selection);
  });

  it('never overrides explicit configuration', async () => {
    const result = await applyRoutingDecision(
      selection,
      { ...decision, reasonCodes: ['EXPLICIT_CONFIG'] },
      'plan',
      { probe: async (id) => availability(id) },
    );
    expect(result.selection).toBe(selection);
  });

  it('walks the ranked list when the top target is unavailable', async () => {
    const result = await applyRoutingDecision(selection, decision, 'plan', {
      probe: async (id) =>
        availability(id, {
          installed: true,
          authentication: id === 'claude' ? 'unverified' : 'failed',
          state: id === 'claude' ? 'conditional' : 'unavailable',
        }),
    });
    expect(result.applied).toBe(true);
    expect(result.selection.provider).toBe('claude');
    expect(result.fallbackFrom).toEqual([
      expect.objectContaining({ provider: 'codex', reason: 'not authenticated' }),
    ]);
    expect(result.warning).toContain('fell back to claude');
  });

  it('degrades to the original selection when no ranked target is usable', async () => {
    const result = await applyRoutingDecision(selection, decision, 'plan', {
      probe: async (id) =>
        availability(id, {
          installed: false,
          authentication: 'failed',
          state: 'unavailable',
        }),
    });
    expect(result.selection).toBe(selection);
    expect(result.applied).toBe(false);
    expect(result.warning).toContain('no usable ranked target');
  });
});
