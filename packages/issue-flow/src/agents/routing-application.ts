import type { RoutingDecision } from '../routing/types.js';
import type { AgentAvailability } from './availability.js';
import { probeAgent } from './availability.js';
import { runnerFor } from './registry.js';
import type { AgentSelection } from './select.js';
import type { AgentPhase, AgentProviderId } from './types.js';
import { isAgentProviderId } from './types.js';

export interface RoutingApplicationResult {
  selection: AgentSelection;
  applied: boolean;
  warning: string | null;
  /** Candidates tried before the applied (or final failed) target. */
  fallbackFrom: Array<{ provider: string; model: string | null; reason: string }>;
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

function isAttemptable(availability: AgentAvailability): boolean {
  return (
    availability.installed &&
    availability.authentication !== 'failed' &&
    availability.state !== 'unavailable'
  );
}

/**
 * Apply an active decision without changing invocation permission. Walks the
 * ranked eligible list when the top target is unavailable; explicit config is
 * never overridden. Fail-open to the original selection when nothing works.
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
    return { selection: original, applied: false, warning: null, fallbackFrom: [] };
  }

  const probe = options.probe ?? probeAgent;
  const ranked = decision.candidates
    .filter((candidate) => candidate.eligible)
    .sort((a, b) => b.score - a.score);
  const fallbackFrom: RoutingApplicationResult['fallbackFrom'] = [];

  for (const candidate of ranked) {
    if (!isAgentProviderId(candidate.provider)) {
      fallbackFrom.push({
        provider: candidate.provider,
        model: candidate.model ?? null,
        reason: 'unregistered provider',
      });
      continue;
    }
    if (
      candidate.model !== null &&
      candidate.model !== undefined &&
      !runnerFor(candidate.provider).capabilities.modelSelection
    ) {
      fallbackFrom.push({
        provider: candidate.provider,
        model: candidate.model,
        reason: 'rejects model selection',
      });
      continue;
    }

    const availability = await probe(candidate.provider);
    if (!isAttemptable(availability)) {
      fallbackFrom.push({
        provider: candidate.provider,
        model: candidate.model ?? null,
        reason: availability.installed
          ? availability.authentication === 'failed'
            ? 'not authenticated'
            : `state=${availability.state}`
          : 'not installed',
      });
      continue;
    }

    const warning =
      fallbackFrom.length > 0
        ? `Routing fell back to ${candidate.provider}:${candidate.model ?? 'default'} for ${phase} after ${fallbackFrom.map((entry) => `${entry.provider} (${entry.reason})`).join(', ')}.`
        : null;

    return {
      applied: true,
      warning,
      fallbackFrom,
      selection: {
        ...original,
        primary: candidate.provider,
        provider: candidate.provider,
        settings: {
          ...original.settings,
          provider: candidate.provider,
          model: candidate.model ?? null,
          origin: { provider: 'default', model: 'default' },
        },
        failover: false,
        reason: null,
        cooldownUntil: null,
      },
    };
  }

  const tried =
    fallbackFrom.length > 0
      ? fallbackFrom.map((entry) => `${entry.provider} (${entry.reason})`).join(', ')
      : 'no eligible candidates';
  return {
    selection: original,
    applied: false,
    fallbackFrom,
    warning: `Routing found no usable ranked target for ${phase} (${tried}); using ${original.provider}.`,
  };
}
