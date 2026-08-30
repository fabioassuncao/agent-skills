import { describe, expect, it } from 'vitest';
import type { RoutingDecision } from '../routing/types.js';
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
    origin: { provider: 'default', model: 'default' },
  },
  healthFile: null,
  failover: false,
  reason: null,
  cooldownUntil: null,
};

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
      score: 0.5,
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

const available = async (id: 'claude' | 'codex' | 'cursor' | 'antigravity') => ({
  id,
  installed: true,
  authenticated: true,
  version: 'test',
  detail: 'test',
});

describe('applyRoutingDecision', () => {
  it('formats recommend output without changing the selection', async () => {
    const recommend = { ...decision, mode: 'recommend' as const };
    expect(routingRecommendationLine(recommend, 'plan')).toContain(
      'Routing suggests codex:gpt-5.6-luna (fast) for plan',
    );
    const result = await applyRoutingDecision(selection, recommend, 'plan', { probe: available });
    expect(result.selection).toBe(selection);
  });

  it('changes provider and concrete model only in active mode', async () => {
    const result = await applyRoutingDecision(selection, decision, 'plan', { probe: available });
    expect(result.applied).toBe(true);
    expect(result.selection.provider).toBe('codex');
    expect(result.selection.settings.model).toBe('gpt-5.6-luna');

    const shadow = await applyRoutingDecision(selection, { ...decision, mode: 'shadow' }, 'plan', {
      probe: available,
    });
    expect(shadow.selection).toBe(selection);
  });

  it('never overrides explicit configuration', async () => {
    const result = await applyRoutingDecision(
      selection,
      { ...decision, reasonCodes: ['EXPLICIT_CONFIG'] },
      'plan',
      { probe: available },
    );
    expect(result.selection).toBe(selection);
  });

  it('degrades to the original selection when the target is unavailable', async () => {
    const result = await applyRoutingDecision(selection, decision, 'plan', {
      probe: async (id) => ({
        id,
        installed: false,
        authenticated: false,
        version: null,
        detail: '',
      }),
    });
    expect(result.selection).toBe(selection);
    expect(result.warning).toContain('not installed');
  });
});
