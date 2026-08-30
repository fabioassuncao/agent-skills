import type { AgentCapabilities, AgentPhase } from '../agents/types.js';

export interface EligibilityInput {
  harness: string;
  capabilities: AgentCapabilities;
  phase: AgentPhase;
  requiresExtraDirectories: boolean;
}

export interface Eligibility {
  eligible: boolean;
  reasonCodes: string[];
}

/**
 * Restriction missing (`toolAllowlist`) is ignored. Enablement missing
 * (`extraDirectories`) is ineligible when the phase needs addDirs.
 */
export function filterEligible(input: EligibilityInput): Eligibility {
  const reasons: string[] = [];
  if (input.requiresExtraDirectories && input.capabilities.extraDirectories === 'none') {
    reasons.push('MISSING_CAPABILITY:extraDirectories');
  }
  return { eligible: reasons.length === 0, reasonCodes: reasons };
}
