import type { CostRecord, StopReason } from '../telemetry/types.js';

export interface RoutingCeilings {
  maxCostUsdPerIssue: number | null;
  maxDurationMsPerIssue: number | null;
  maxExecutionsPerIssue: number | null;
  onCeiling: 'block';
}

export const DEFAULT_CEILINGS: RoutingCeilings = {
  maxCostUsdPerIssue: null,
  maxDurationMsPerIssue: null,
  maxExecutionsPerIssue: null,
  onCeiling: 'block',
};

export interface SpentSnapshot {
  /** Observed reported USD only. `unknown` / `estimated` do not fill this. */
  reportedUsd: number;
  costStatus: CostRecord['status'];
  durationMs: number;
  executions: number;
}

export type CeilingBinding = 'cost' | 'duration' | 'executions';

export type CeilingVerdict =
  | { ok: true; binding: null }
  | {
      ok: false;
      stopReason: Extract<StopReason, 'max_cost' | 'max_duration' | 'max_attempts'>;
      binding: CeilingBinding;
      onCeiling: 'block';
      numbers: { spent: number; ceiling: number };
      /** Which ceiling is actually in force when cost is unknown. */
      enforced: CeilingBinding[];
    };

/**
 * Single choke point. A harness flag is never a substitute: a runner that
 * ignores `--max-budget-usd` still stops here.
 */
export function evaluateCeilings(input: {
  ceilings?: Partial<RoutingCeilings> | undefined;
  spent: SpentSnapshot;
}): CeilingVerdict {
  const ceilings = { ...DEFAULT_CEILINGS, ...input.ceilings };
  const enforced: CeilingBinding[] = [];
  if (ceilings.maxCostUsdPerIssue !== null && input.spent.costStatus === 'reported') {
    enforced.push('cost');
  }
  if (ceilings.maxDurationMsPerIssue !== null) enforced.push('duration');
  if (ceilings.maxExecutionsPerIssue !== null) enforced.push('executions');

  if (
    ceilings.maxCostUsdPerIssue !== null &&
    input.spent.costStatus === 'reported' &&
    input.spent.reportedUsd >= ceilings.maxCostUsdPerIssue
  ) {
    return {
      ok: false,
      stopReason: 'max_cost',
      binding: 'cost',
      onCeiling: 'block',
      numbers: { spent: input.spent.reportedUsd, ceiling: ceilings.maxCostUsdPerIssue },
      enforced,
    };
  }

  if (
    ceilings.maxDurationMsPerIssue !== null &&
    input.spent.durationMs >= ceilings.maxDurationMsPerIssue
  ) {
    return {
      ok: false,
      stopReason: 'max_duration',
      binding: 'duration',
      onCeiling: 'block',
      numbers: { spent: input.spent.durationMs, ceiling: ceilings.maxDurationMsPerIssue },
      enforced,
    };
  }

  if (
    ceilings.maxExecutionsPerIssue !== null &&
    input.spent.executions >= ceilings.maxExecutionsPerIssue
  ) {
    return {
      ok: false,
      stopReason: 'max_attempts',
      binding: 'executions',
      onCeiling: 'block',
      numbers: { spent: input.spent.executions, ceiling: ceilings.maxExecutionsPerIssue },
      enforced,
    };
  }

  return { ok: true, binding: null };
}

export function spendFromCost(cost: CostRecord): Pick<SpentSnapshot, 'reportedUsd' | 'costStatus'> {
  if (cost.status === 'reported') {
    return { reportedUsd: cost.amount, costStatus: 'reported' };
  }
  return { reportedUsd: 0, costStatus: cost.status };
}

/** `blocked` is only left by a human — the machine never unblocks a ceiling. */
export function canLeaveBlocked(actor: string): boolean {
  return actor === 'human';
}
