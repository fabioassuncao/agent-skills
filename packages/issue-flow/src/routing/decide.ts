import type { AgentPhase } from '../agents/types.js';
import { CLAUDE_CAPABILITIES, CODEX_CAPABILITIES, CURSOR_CAPABILITIES } from '../agents/types.js';
import { analyzeTask } from './analyze.js';
import { filterEligible } from './capabilities.js';
import { PRIORS_VERSION } from './priors.js';
import { pickSelected, scoreCandidates } from './score.js';
import type { RoutingDecision, RoutingMode, RoutingProfile, TaskSignals } from './types.js';

const CAPS = {
  'claude-code': CLAUDE_CAPABILITIES,
  'codex-cli': CODEX_CAPABILITIES,
  'cursor-cli': CURSOR_CAPABILITIES,
} as const;

const PROVIDER: Record<string, string> = {
  'claude-code': 'claude',
  'codex-cli': 'codex',
  'cursor-cli': 'cursor',
};

export function decideRouting(input: {
  signals?: TaskSignals;
  phase: AgentPhase;
  actualHarness: string;
  mode: RoutingMode;
  profile?: RoutingProfile;
  requiresExtraDirectories?: boolean;
  skipScore?: boolean;
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
      selected: input.actualHarness,
      actual: input.actualHarness,
      reasonCodes: ['EXPLICIT_CONFIG'],
    };
  }

  const scored = scoreCandidates(
    (Object.keys(CAPS) as (keyof typeof CAPS)[]).map((harness) => {
      const eligibility = filterEligible({
        harness,
        capabilities: CAPS[harness],
        phase: input.phase,
        requiresExtraDirectories: input.requiresExtraDirectories === true,
      });
      return {
        harness,
        provider: PROVIDER[harness] ?? harness,
        eligible: eligibility.eligible,
        reasonCodes: eligibility.reasonCodes,
        taskClass: analyzed.taskClass,
        profile,
      };
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
    selected: selected.harness,
    actual: input.actualHarness,
    reasonCodes: selected.reasonCodes.includes('COLD_START')
      ? ['HIGH_PRIOR', ...selected.reasonCodes]
      : selected.reasonCodes,
  };
}
