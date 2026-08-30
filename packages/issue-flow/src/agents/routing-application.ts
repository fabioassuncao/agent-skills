import type { RoutingDecision } from '../routing/types.js';
import { type AgentAvailability, probeAgent } from './availability.js';
import { runnerFor } from './registry.js';
import type { AgentSelection } from './select.js';
import type { AgentPhase, AgentProviderId } from './types.js';
import { isAgentProviderId } from './types.js';

export interface RoutingApplicationResult {
  selection: AgentSelection;
  applied: boolean;
  warning: string | null;
}

export function routingRecommendationLine(
  decision: RoutingDecision | null,
  phase: AgentPhase,
): string | null {
  if (
    decision === null ||
    decision.mode !== 'recommend' ||
    decision.reasonCodes.includes('EXPLICIT_CONFIG')
  ) {
    return null;
  }
  const tier = decision.selected.tier ? ` (${decision.selected.tier})` : '';
  return `Routing suggests ${decision.selected.provider}:${decision.selected.model ?? 'default'}${tier} for ${phase} (${decision.reasonCodes.join(', ')}) · apply with routing.mode active`;
}

/**
 * Apply an active decision without changing invocation permission. Any invalid
 * or unavailable target falls back to the already-resolved selection.
 */
export async function applyRoutingDecision(
  original: AgentSelection,
  decision: RoutingDecision | null,
  phase: AgentPhase,
  options: { probe?: (provider: AgentProviderId) => Promise<AgentAvailability> } = {},
): Promise<RoutingApplicationResult> {
  if (
    decision === null ||
    decision.mode !== 'active' ||
    decision.reasonCodes.includes('EXPLICIT_CONFIG') ||
    original.failover
  ) {
    return { selection: original, applied: false, warning: null };
  }

  const target = decision.selected;
  if (!isAgentProviderId(target.provider)) {
    return {
      selection: original,
      applied: false,
      warning: `Routing target '${target.provider}' is not a registered provider for ${phase}; using ${original.provider}.`,
    };
  }
  const selectedCandidate = decision.candidates.find(
    (candidate) =>
      candidate.eligible &&
      candidate.harness === target.harness &&
      candidate.provider === target.provider &&
      candidate.model === (target.model ?? null),
  );
  if (selectedCandidate === undefined) {
    return {
      selection: original,
      applied: false,
      warning: `Routing target ${target.provider}:${target.model ?? 'default'} is not an eligible catalog entry for ${phase}; using ${original.provider}.`,
    };
  }
  if (
    target.model !== null &&
    target.model !== undefined &&
    !runnerFor(target.provider).capabilities.modelSelection
  ) {
    return {
      selection: original,
      applied: false,
      warning: `Routing target ${target.provider} rejects model selection for ${phase}; using ${original.provider}.`,
    };
  }

  const availability = await (options.probe ?? probeAgent)(target.provider);
  if (!availability.installed || !availability.authenticated) {
    return {
      selection: original,
      applied: false,
      warning: `Routing target ${target.provider} is ${availability.installed ? 'not authenticated' : 'not installed'} for ${phase}; using ${original.provider}.`,
    };
  }

  return {
    applied: true,
    warning: null,
    selection: {
      ...original,
      primary: target.provider,
      provider: target.provider,
      settings: {
        ...original.settings,
        provider: target.provider,
        model: target.model ?? null,
        origin: { provider: 'default', model: 'default' },
      },
      failover: false,
      reason: null,
      cooldownUntil: null,
    },
  };
}
