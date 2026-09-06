import type { ReadinessSnapshot } from '../agents/availability.js';
import type { AgentPhase } from '../agents/types.js';
import {
  ANTIGRAVITY_CAPABILITIES,
  CLAUDE_CAPABILITIES,
  CODEX_CAPABILITIES,
  CURSOR_CAPABILITIES,
  OPENCODE_CAPABILITIES,
} from '../agents/types.js';
import { analyzeTask } from './analyze.js';
import { filterEligible } from './capabilities.js';
import { MODEL_CATALOG_VERSION, modelsFor } from './models.js';
import { RECOMMENDED_POLICY_VERSION, recommendedFor } from './policy.js';
import { PRIORS_VERSION } from './priors.js';
import { pickSelected, scoreCandidates } from './score.js';
import type { RoutingDecision, RoutingMode, RoutingProfile, TaskSignals } from './types.js';

const CAPS = {
  'claude-code': CLAUDE_CAPABILITIES,
  'codex-cli': CODEX_CAPABILITIES,
  'cursor-cli': CURSOR_CAPABILITIES,
  'antigravity-cli': ANTIGRAVITY_CAPABILITIES,
  'opencode-cli': OPENCODE_CAPABILITIES,
} as const;

const PROVIDER: Record<string, string> = {
  'claude-code': 'claude',
  'codex-cli': 'codex',
  'cursor-cli': 'cursor',
  'antigravity-cli': 'antigravity',
  'opencode-cli': 'opencode',
};

export function decideRouting(input: {
  signals?: TaskSignals;
  phase: AgentPhase;
  actualHarness: string;
  actualProvider?: string;
  actualModel?: string | null;
  mode: RoutingMode;
  profile?: RoutingProfile;
  requiresExtraDirectories?: boolean;
  skipScore?: boolean;
  policy?: 'recommended';
  /** Injected inventory — router stays pure (no probes). */
  readiness?: ReadinessSnapshot | null;
}): RoutingDecision | null {
  if (input.mode === 'off') return null;
  const analyzed = analyzeTask(input.signals ?? {});
  const profile = input.profile ?? 'balanced';
  const policyVersion = `${PRIORS_VERSION}:${MODEL_CATALOG_VERSION}:${input.policy === 'recommended' ? RECOMMENDED_POLICY_VERSION : 'adaptive'}`;

  if (input.skipScore) {
    return {
      policyVersion,
      profile,
      taskClass: analyzed.taskClass,
      risk: analyzed.risk,
      mode: input.mode,
      candidates: [],
      selected: {
        harness: input.actualHarness,
        provider: input.actualProvider ?? PROVIDER[input.actualHarness] ?? input.actualHarness,
        model: input.actualModel ?? null,
      },
      actual: {
        harness: input.actualHarness,
        provider: input.actualProvider ?? PROVIDER[input.actualHarness] ?? input.actualHarness,
        model: input.actualModel ?? null,
      },
      reasonCodes: ['EXPLICIT_CONFIG'],
    };
  }

  const recommendation = input.policy === 'recommended' ? recommendedFor(input.phase) : null;
  const allowConditional = recommendation?.allowConditional !== false;

  const scored = scoreCandidates(
    (Object.keys(CAPS) as (keyof typeof CAPS)[]).flatMap((harness) => {
      const providerId = PROVIDER[harness] as
        | 'claude'
        | 'codex'
        | 'cursor'
        | 'antigravity'
        | 'opencode';
      const readiness =
        input.readiness === undefined || input.readiness === null
          ? null
          : (input.readiness.providers[providerId] ?? null);
      const eligibility = filterEligible({
        harness,
        capabilities: CAPS[harness],
        phase: input.phase,
        requiresExtraDirectories: input.requiresExtraDirectories === true,
        readiness,
        allowConditional,
      });
      return modelsFor(harness, CAPS[harness]).map((model) => {
        const reasonCodes = [...eligibility.reasonCodes];
        const preferredTierMatch =
          recommendation !== null && model.tier === recommendation.preferredTier;
        const affinityMatch = recommendation !== null && recommendation.affinityHarness === harness;
        if (preferredTierMatch) reasonCodes.push('RECOMMENDED_POLICY');
        if (affinityMatch) reasonCodes.push('HARNESS_AFFINITY');
        if (model.tier === 'fast' && analyzed.risk !== 'high') {
          reasonCodes.push('CHEAPER_TIER_SUFFICIENT');
        }
        if (model.tier === 'strong' && (analyzed.risk === 'high' || profile === 'quality')) {
          reasonCodes.push('STRONGER_TIER_FOR_RISK');
        }
        return {
          harness,
          provider: providerId,
          model: model.id,
          tier: model.tier,
          relativeCost: model.relativeCost,
          relativeLatency: model.relativeLatency,
          eligible: eligibility.eligible,
          reasonCodes,
          taskClass: analyzed.taskClass,
          profile,
          readinessState: readiness?.state ?? null,
          preferredTierMatch,
          affinityMatch,
        };
      });
    }),
  );
  const selected = pickSelected(scored);
  return {
    policyVersion,
    profile,
    taskClass: analyzed.taskClass,
    risk: analyzed.risk,
    mode: input.mode,
    candidates: scored,
    selected: {
      harness: selected.harness,
      provider: selected.provider,
      model: selected.model ?? null,
      tier: selected.tier,
    },
    actual: {
      harness: input.actualHarness,
      provider: input.actualProvider ?? PROVIDER[input.actualHarness] ?? input.actualHarness,
      model: input.actualModel ?? null,
    },
    reasonCodes: selected.reasonCodes.includes('COLD_START')
      ? ['HIGH_PRIOR', ...selected.reasonCodes]
      : selected.reasonCodes,
  };
}
