/**
 * Durations, clocks and metrics, exactly as the panel formats them.
 *
 * PORT of the formatting half of `web/public/app.js` @ the current panel.
 * Nothing here is new; what matters is that it is *identical*, because two of
 * these functions have contracts outside this file:
 *
 * - **`formatUsage` mirrors `formatTokens()` in `src/core/metrics.ts`** — same
 *   segment order (`in / out · cache · ~$`), same compaction (`1.5k`/`2.4M`).
 *   The one deliberate divergence is the cost, which the panel prints with two
 *   decimals (four below a cent) because it is read at a glance while the
 *   terminal is read for precision. **If `metrics.ts` changes format, both move.**
 * - **`metric()` is the U18 guard.** A `session.json` written by an older
 *   release is missing fields entirely (`undefined`), and a newer one may carry
 *   them as `null`. Both mean "not reported" and neither may reach the screen
 *   as `0` or `NaN`. Prefer `x !== null && x !== undefined` over `!x`: zero is a
 *   legitimate value.
 */

/** `null` for anything that is not a finite number — never `0`, never `NaN`. */
export function metric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseIso(iso: unknown): number | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Em dash for an absent value: the placeholder the glossary reserves for it. */
export const ABSENT = '—';

export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || totalSeconds < 0) return ABSENT;
  const seconds = Math.round(totalSeconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}min`;
}

export function formatAgo(iso: unknown, now: number = Date.now()): string {
  const ms = parseIso(iso);
  if (ms === null) return '';
  return `há ${formatDuration((now - ms) / 1000)}`;
}

export function formatClock(iso: unknown): string {
  const ms = parseIso(iso);
  if (ms === null) return '';
  return new Date(ms).toLocaleTimeString('pt-BR');
}

/** `1523` → `1.5k`, `2_400_000` → `2.4M`. Same rule as the terminal summary. */
export function compactTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** Costs below a cent would lose all meaning with two decimals. */
export function formatCost(value: number, approximate?: boolean): string {
  const prefix = approximate === false ? '$' : '~$';
  return prefix + (Math.abs(value) < 0.01 ? value.toFixed(4) : value.toFixed(2));
}

export interface UsageLike {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheCreationTokens?: unknown;
  costUsd?: unknown;
}

/**
 * `12.4k in / 3.1k out · 88.0k cache · ~$0.42`.
 *
 * A segment with no data is omitted; no data at all returns `''`, which is the
 * signal not to render the slot rather than to render an empty one.
 */
export function formatUsage(usage: UsageLike | null | undefined): string {
  if (!usage) return '';
  const segments: string[] = [];

  const input = metric(usage.inputTokens);
  const output = metric(usage.outputTokens);
  const io: string[] = [];
  if (input !== null) io.push(`${compactTokens(input)} in`);
  if (output !== null) io.push(`${compactTokens(output)} out`);
  if (io.length > 0) segments.push(io.join(' / '));

  const cacheRead = metric(usage.cacheReadTokens);
  const cacheCreation = metric(usage.cacheCreationTokens);
  if (cacheRead !== null || cacheCreation !== null) {
    segments.push(`${compactTokens((cacheRead ?? 0) + (cacheCreation ?? 0))} cache`);
  }

  const cost = metric(usage.costUsd);
  if (cost !== null) segments.push(formatCost(cost));

  return segments.join(' · ');
}

export interface TotalsLike {
  totalInputTokens?: unknown;
  totalOutputTokens?: unknown;
  totalCacheReadTokens?: unknown;
  totalCacheCreationTokens?: unknown;
  totalCostUsd?: unknown;
}

/** The issue-wide aggregate uses `total*` names; translate, then format once. */
export function formatTotals(metrics: TotalsLike | null | undefined): string {
  if (!metrics) return '';
  return formatUsage({
    inputTokens: metrics.totalInputTokens,
    outputTokens: metrics.totalOutputTokens,
    cacheReadTokens: metrics.totalCacheReadTokens,
    cacheCreationTokens: metrics.totalCacheCreationTokens,
    costUsd: metrics.totalCostUsd,
  });
}

/** Duration and metrics share one slot, joined by ` · `; empty parts drop out. */
export function itemSideText(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' · ');
}

export function truncateText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value === '') return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

/** Repository root derived from the issue URL (`…/issues/N` → the repo). */
export function repoUrlFromIssueUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const match = url.match(/^(https?:\/\/\S+?)\/issues\/\d+\/?$/);
  return match ? match[1] : null;
}
