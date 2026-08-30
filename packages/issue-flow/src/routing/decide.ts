import type { AgentPhase } from '../agents/types.js';
import {
  ANTIGRAVITY_CAPABILITIES,
  CLAUDE_CAPABILITIES,
  CODEX_CAPABILITIES,
  CURSOR_CAPABILITIES,
} from '../agents/types.js';
import { analyzeTask } from './analyze.js';
import { filterEligible } from './capabilities.js';
import { modelsFor } from './models.js';
import { recommendedFor } from './policy.js';
import { PRIORS_VERSION } from './priors.js';
import { pickSelected, scoreCandidates } from './score.js';
import type { RoutingDecision, RoutingMode, RoutingProfile, TaskSignals } from './types.js';

const CAPS = {
  'claude-code': CLAUDE_CAPABILITIES,
  'codex-cli': CODEX_CAPABILITIES,
  'cursor-cli': CURSOR_CAPABILITIES,
  'antigravity-cli': ANTIGRAVITY_CAPABILITIES,
} as const;

const PROVIDER: Record<string, string> = {
  'claude-code': 'claude',
  'codex-cli': 'codex',
  'cursor-cli': 'cursor',
  'antigravity-cli': 'antigravity',
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
}): RoutingDecision | null {
  if (input.mode === 'off') return null;
  const analyzed = analyzeTask(input.signals ?? {});
  const profile = input.profile ?? 'balanced';

  if (input.skipScore) {
    return {
      policyVersion: PRIORS_VERSION,
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

  const scored = scoreCandidates(
    (Object.keys(CAPS) as (keyof typeof CAPS)[]).flatMap((harness) => {
      const eligibility = filterEligible({
        harness,
        capabilities: CAPS[harness],
        phase: input.phase,
        requiresExtraDirectories: input.requiresExtraDirectories === true,
      });
      const recommendation = input.policy === 'recommended' ? recommendedFor(input.phase) : null;
      return modelsFor(harness, CAPS[harness]).map((model) => ({
        harness,
        provider: PROVIDER[harness] ?? harness,
        model: model.id,
        tier: model.tier,
        relativeCost: model.relativeCost,
        relativeLatency: model.relativeLatency,
        eligible:
          eligibility.eligible &&
          (recommendation === null ||
            (model.tier === recommendation.tier &&
              (recommendation.preferHarness === undefined ||
                recommendation.preferHarness === harness))),
        reasonCodes: [
          ...eligibility.reasonCodes,
          ...(recommendation !== null &&
          model.tier === recommendation.tier &&
          (recommendation.preferHarness === undefined || recommendation.preferHarness === harness)
            ? ['RECOMMENDED_POLICY']
            : []),
          ...(model.tier === 'fast' && analyzed.risk !== 'high' ? ['CHEAPER_TIER_SUFFICIENT'] : []),
          ...(model.tier === 'strong' && (analyzed.risk === 'high' || profile === 'quality')
            ? ['STRONGER_TIER_FOR_RISK']
            : []),
        ],
        taskClass: analyzed.taskClass,
        profile,
        costStatus: 'reported' as const,
      }));
    }),
  );
  const selected = pickSelected(scored);
  return {
    policyVersion: PRIORS_VERSION,
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
