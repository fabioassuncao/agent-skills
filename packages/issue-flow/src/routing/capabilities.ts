import type { ProviderReadiness } from '../agents/availability.js';
import type { AgentCapabilities, AgentPhase } from '../agents/types.js';

export interface EligibilityInput {
  harness: string;
  capabilities: AgentCapabilities;
  phase: AgentPhase;
  requiresExtraDirectories: boolean;
  readiness?: ProviderReadiness | null;
  /** Default true. When false, conditional/unverified providers are ineligible. */
  allowConditional?: boolean;
}

export interface Eligibility {
  eligible: boolean;
  reasonCodes: string[];
}

/**
 * Restriction missing (`toolAllowlist`) is ignored. Enablement missing
 * (`extraDirectories`) is ineligible when the phase needs addDirs.
 * Readiness is injected by the caller — this module stays pure.
 */
export function filterEligible(input: EligibilityInput): Eligibility {
  const reasons: string[] = [];
  let eligible = true;

  if (input.requiresExtraDirectories && input.capabilities.extraDirectories === 'none') {
    reasons.push('MISSING_CAPABILITY:extraDirectories');
    reasons.push('CAPABILITY_MISMATCH');
    eligible = false;
  }

  const readiness = input.readiness;
  if (readiness !== undefined && readiness !== null) {
    if (!readiness.installed) {
      reasons.push('PROVIDER_NOT_INSTALLED');
      eligible = false;
    } else if (
      readiness.cooldownUntil !== null &&
      Date.parse(readiness.cooldownUntil) > Date.parse(readiness.observedAt)
    ) {
      reasons.push('PROVIDER_COOLDOWN');
      eligible = false;
    } else if (readiness.authentication === 'failed') {
      reasons.push('AUTHENTICATION_FAILED');
      reasons.push('PROVIDER_UNAVAILABLE');
      eligible = false;
    } else if (readiness.state === 'unavailable') {
      reasons.push('PROVIDER_UNAVAILABLE');
      eligible = false;
    } else if (readiness.authentication === 'unverified' || readiness.state === 'conditional') {
      reasons.push('AUTHENTICATION_UNVERIFIED');
      reasons.push('READINESS_CONDITIONAL');
      if (input.allowConditional === false) {
        reasons.push('PROVIDER_UNAVAILABLE');
        eligible = false;
      }
    } else {
      reasons.push('READINESS_CONFIRMED');
    }

    const modelAccess = readiness.models[0]?.access;
    if (modelAccess === 'denied') {
      reasons.push('MODEL_NOT_ACCESSIBLE');
      eligible = false;
    } else if (modelAccess === 'unverified') {
      reasons.push('MODEL_ACCESS_UNVERIFIED');
    }
  }

  return { eligible, reasonCodes: reasons };
}
