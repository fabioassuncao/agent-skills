import { isoNow } from '../core/state-manager.js';
import type { CostRecord, NormalizedUsage, PricingSnapshot, TelemetryConfig } from './types.js';

export const PRICING_TABLE_VERSION = '2026-08-30';

interface PricingRow {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

/** Microdollars-per-million would be more precise; dollars keep the snapshot readable. */
const TABLE: Record<string, PricingRow> = {
  'claude-sonnet-4': {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  'claude-sonnet-4-5': {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  'claude-opus-4': {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheReadPerMillion: 1.5,
    cacheWritePerMillion: 18.75,
  },
  'gpt-5': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gpt-5.1': { inputPerMillion: 1.25, outputPerMillion: 10 },
};

/** Aliases a harness accepts in place of a model id. */
const ALIASES: Record<string, string> = {
  sonnet: 'claude-sonnet-4-5',
  opus: 'claude-opus-4',
};

/**
 * Map a resolved model id onto a table key.
 *
 * What reaches here is whatever the harness reported: a dated snapshot
 * (`claude-sonnet-4-5-20250929`), a vendor-prefixed id
 * (`anthropic/claude-sonnet-4-5`) or a configured alias (`sonnet`). An exact
 * lookup misses all three, and the estimate silently degrades to `unknown`.
 * An override is always honoured under the key the user wrote.
 */
export function normalizeModelKey(modelKey: string): string {
  const lower = modelKey.trim().toLowerCase();
  const withoutVendor = lower.slice(lower.lastIndexOf('/') + 1);
  const withoutSnapshot = withoutVendor.replace(/-\d{8}$/, '').replace(/-latest$/, '');
  return ALIASES[withoutSnapshot] ?? withoutSnapshot;
}

function rowFor(
  modelKey: string,
  overrides: TelemetryConfig['pricing']['overrides'],
): PricingRow | null {
  const normalized = normalizeModelKey(modelKey);
  const override = overrides[modelKey] ?? overrides[normalized];
  const base = TABLE[modelKey] ?? TABLE[normalized];
  if (override === undefined && base === undefined) return null;
  return {
    inputPerMillion: override?.inputPerMillion ?? base?.inputPerMillion ?? 0,
    outputPerMillion: override?.outputPerMillion ?? base?.outputPerMillion ?? 0,
    cacheReadPerMillion: override?.cacheReadPerMillion ?? base?.cacheReadPerMillion,
    cacheWritePerMillion: override?.cacheWritePerMillion ?? base?.cacheWritePerMillion,
  };
}

function dollars(tokens: number | undefined, perMillion: number | undefined): number {
  if (tokens === undefined || perMillion === undefined) return 0;
  return (tokens * perMillion) / 1_000_000;
}

export function resolveCost(options: {
  reportedUsd?: number | null;
  usage: NormalizedUsage | null;
  modelKey: string | null;
  estimate: boolean;
  overrides?: TelemetryConfig['pricing']['overrides'];
}): CostRecord {
  if (options.reportedUsd !== undefined && options.reportedUsd !== null) {
    return { status: 'reported', amount: options.reportedUsd, currency: 'USD' };
  }
  if (!options.estimate) {
    return { status: 'unknown', reason: 'not_reported' };
  }
  if (options.modelKey === null || options.modelKey === '') {
    return { status: 'unknown', reason: 'unknown_model' };
  }
  const row = rowFor(options.modelKey, options.overrides ?? {});
  if (row === null) {
    return { status: 'unknown', reason: 'unknown_model' };
  }
  if (options.usage === null || options.usage.source === 'unavailable') {
    return { status: 'unknown', reason: 'not_reported' };
  }
  const amount =
    dollars(options.usage.inputTokens, row.inputPerMillion) +
    dollars(options.usage.outputTokens, row.outputPerMillion) +
    dollars(options.usage.cacheReadTokens, row.cacheReadPerMillion) +
    dollars(options.usage.cacheCreationTokens, row.cacheWritePerMillion);
  const pricing: PricingSnapshot = {
    tableVersion: PRICING_TABLE_VERSION,
    modelKey: options.modelKey,
    inputPerMillion: row.inputPerMillion,
    outputPerMillion: row.outputPerMillion,
    capturedAt: isoNow(),
    ...(row.cacheReadPerMillion === undefined
      ? {}
      : { cacheReadPerMillion: row.cacheReadPerMillion }),
    ...(row.cacheWritePerMillion === undefined
      ? {}
      : { cacheWritePerMillion: row.cacheWritePerMillion }),
  };
  return { status: 'estimated', amount, currency: 'USD', pricing };
}

export function estimateCost(
  usage: NormalizedUsage,
  modelKey: string,
  overrides: TelemetryConfig['pricing']['overrides'] = {},
): CostRecord {
  return resolveCost({ usage, modelKey, estimate: true, overrides });
}
