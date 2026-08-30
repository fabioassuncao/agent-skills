import { describeRunAgents, hasExplicitAgentSelection } from '../../agents/resolve.js';
import {
  getActiveResilienceConfig,
  getAgentCliOverrides,
  loadAgentConfig,
  loadRoutingConfig,
} from '../../config.js';
import type { SessionConfigurationSnapshot } from '../../core/session-state.js';
import { recommendedTarget } from '../../routing/policy.js';

export async function buildAgentConfiguration(prReview: boolean | undefined): Promise<{
  agentSummary: Awaited<ReturnType<typeof describeRunAgents>>;
  configurationSnapshot: SessionConfigurationSnapshot;
}> {
  const agentSummary = await describeRunAgents(
    prReview
      ? ['prd', 'plan', 'execute', 'review', 'pr', 'pr-review']
      : ['prd', 'plan', 'execute', 'review', 'pr'],
  );
  const fallbacks = getActiveResilienceConfig().providers?.chain ?? [];
  const routingConfig = await loadRoutingConfig();
  const agentConfig = await loadAgentConfig();
  const displayedPhases = Object.entries(agentSummary.byPhase).map(([phase, resolved]) => {
    const recommended =
      routingConfig.mode === 'active' &&
      routingConfig.policy === 'recommended' &&
      !hasExplicitAgentSelection(
        agentConfig,
        getAgentCliOverrides(),
        phase as keyof typeof agentSummary.byPhase,
      )
        ? recommendedTarget(phase as keyof typeof agentSummary.byPhase)
        : null;
    return {
      phase,
      provider: recommended?.provider ?? resolved.provider,
      model: recommended?.model ?? resolved.model,
      providerSource: recommended ? ('recommended' as const) : resolved.origin.provider,
      modelSource: recommended ? ('recommended' as const) : resolved.origin.model,
    };
  });
  const configurationSnapshot: SessionConfigurationSnapshot = {
    precedence: ['default', 'global', 'project', 'env', 'cli', 'step override'],
    defaultProvider: {
      value: agentSummary.defaultProvider,
      source: agentSummary.defaultOrigin.provider,
    },
    defaultModel: {
      value: agentSummary.defaultModel,
      source: agentSummary.defaultOrigin.model,
    },
    phases: displayedPhases.map((resolved) => ({
      phase: resolved.phase,
      provider: { value: resolved.provider, source: resolved.providerSource },
      model: { value: resolved.model, source: resolved.modelSource },
    })),
    fallbacks,
    overrides: displayedPhases
      .filter(
        (resolved) =>
          resolved.provider !== agentSummary.defaultProvider ||
          resolved.model !== agentSummary.defaultModel,
      )
      .map(
        (resolved) =>
          `${resolved.phase}: ${resolved.provider}${resolved.model ? ` · ${resolved.model}` : ''}`,
      ),
  };
  return { agentSummary, configurationSnapshot };
}
