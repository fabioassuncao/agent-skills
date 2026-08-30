/** Shared percentiles. Used by both the synthetic CI guard and the real campaign. */

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

export function p50(values: number[]): number {
  return percentile(values, 50);
}

export function p95(values: number[]): number {
  return percentile(values, 95);
}
