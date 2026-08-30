import type { AgentProviderId } from '../agents/types.js';
import type { FailureKind } from '../resilience/errors.js';
import type { CheckResult } from '../verify/types.js';

export type FailureClass = 'availability' | 'non-convergence' | 'environment';

export type EscalationRung =
  | 'current'
  | 'effort'
  | 'model'
  | 'harness'
  | 'review'
  | 'decompose'
  | 'blocked';

export const LADDER: readonly EscalationRung[] = [
  'current',
  'effort',
  'model',
  'harness',
  'review',
  'decompose',
  'blocked',
] as const;

export interface EscalationConfig {
  enabled: boolean;
  minAttemptsBeforeEscalation: number;
  maxEscalations: number;
  maxRungs: EscalationRung[];
}

export const DEFAULT_ESCALATION: EscalationConfig = {
  enabled: false,
  minAttemptsBeforeEscalation: 2,
  maxEscalations: 2,
  maxRungs: ['effort', 'model', 'harness'],
};

const AVAILABILITY: ReadonlySet<FailureKind> = new Set([
  'provider_down',
  'provider_crash',
  'rate_limit',
  'network',
]);

const ENVIRONMENT: ReadonlySet<FailureKind> = new Set([
  'configuration',
  'repository_state',
  'authentication',
]);

export interface AttemptSignals {
  results: readonly CheckResult[];
  failureKind?: FailureKind | null;
  fingerprint?: string;
  fatalFailed?: number;
  diffBytes?: number;
}

/**
 * Class A stays with #69. Class C stays with #64. This function never
 * recommends a model change for either.
 */
export function classifyAttempt(input: AttemptSignals): FailureClass {
  if (input.failureKind && AVAILABILITY.has(input.failureKind)) return 'availability';
  if (input.failureKind && ENVIRONMENT.has(input.failureKind)) return 'environment';
  if (input.results.some((result) => result.status === 'could-not-run')) return 'environment';
  if (input.results.some((result) => result.status === 'failed')) return 'non-convergence';
  return 'environment';
}

/** Hash of the failed-check *ids*, never of the error text. */
export function failureFingerprint(results: readonly CheckResult[]): string {
  return results
    .filter((result) => result.status === 'failed')
    .map((result) => result.id)
    .sort()
    .join('\n');
}

export function fatalFailedCount(results: readonly CheckResult[]): number {
  return results.filter((result) => result.fatal && result.status === 'failed').length;
}

export interface ConvergenceHistoryEntry {
  fingerprint: string;
  fatalFailed: number;
  diffBytes?: number;
}

export function detectNonConvergence(input: {
  history: readonly ConvergenceHistoryEntry[];
  minAttempts?: number;
}): { nonConverged: boolean; reason: string } {
  const minAttempts = input.minAttempts ?? DEFAULT_ESCALATION.minAttemptsBeforeEscalation;
  if (input.history.length < minAttempts) {
    return { nonConverged: false, reason: 'below-min-attempts' };
  }

  const latest = input.history[input.history.length - 1];
  const previous = input.history[input.history.length - 2];
  if (latest === undefined || previous === undefined) {
    return { nonConverged: false, reason: 'below-min-attempts' };
  }

  const progressed =
    latest.fatalFailed < previous.fatalFailed ||
    (latest.diffBytes ?? 0) > (previous.diffBytes ?? 0);
  if (progressed) {
    return { nonConverged: false, reason: 'progress' };
  }

  const window = input.history.slice(-minAttempts);
  const samePrint = window.every((entry) => entry.fingerprint === latest.fingerprint);
  if (samePrint && latest.fingerprint !== '') {
    return { nonConverged: true, reason: 'repeated-fingerprint' };
  }
  if (!progressed) {
    return { nonConverged: true, reason: 'no-progress' };
  }
  return { nonConverged: false, reason: 'progress' };
}

export interface NextRungInput {
  tried: readonly EscalationRung[];
  capabilities: {
    reasoningEffort: boolean;
    modelSelection: boolean;
    otherHarness: boolean;
  };
  maxRungs?: readonly EscalationRung[];
  maxEscalations?: number;
  escalationsUsed?: number;
}

export interface NextRungResult {
  rung: EscalationRung;
  skipped: EscalationRung[];
  exhausted: boolean;
}

function hasCapability(rung: EscalationRung, capabilities: NextRungInput['capabilities']): boolean {
  if (rung === 'effort') return capabilities.reasoningEffort;
  if (rung === 'model') return capabilities.modelSelection;
  if (rung === 'harness') return capabilities.otherHarness;
  return true;
}

/**
 * The ladder only climbs. A rejected target is never a candidate again.
 * `claude → codex → claude` is impossible because `harness` is consumed once.
 */
export function nextRung(input: NextRungInput): NextRungResult {
  const allowed = input.maxRungs ?? DEFAULT_ESCALATION.maxRungs;
  const maxEscalations = input.maxEscalations ?? DEFAULT_ESCALATION.maxEscalations;
  const used = input.escalationsUsed ?? input.tried.filter((rung) => rung !== 'current').length;
  if (used >= maxEscalations) {
    return { rung: 'blocked', skipped: [], exhausted: true };
  }

  const skipped: EscalationRung[] = [];
  const tried = new Set(input.tried);
  for (const rung of LADDER) {
    if (rung === 'current') continue;
    if (tried.has(rung)) continue;
    if (rung !== 'blocked' && !allowed.includes(rung)) continue;
    if (!hasCapability(rung, input.capabilities)) {
      skipped.push(rung);
      continue;
    }
    return { rung, skipped, exhausted: rung === 'blocked' };
  }
  return { rung: 'blocked', skipped, exhausted: true };
}

export function escalationCapabilities(provider: AgentProviderId): NextRungInput['capabilities'] {
  return {
    reasoningEffort: provider === 'codex' || provider === 'antigravity',
    modelSelection: true,
    otherHarness: true,
  };
}

/** A harness already used on this task cannot be selected again. */
export function unusedHarness(
  current: AgentProviderId,
  triedHarnesses: readonly AgentProviderId[],
  available: readonly AgentProviderId[],
): AgentProviderId | null {
  const seen = new Set<AgentProviderId>([current, ...triedHarnesses]);
  return available.find((id) => !seen.has(id)) ?? null;
}
