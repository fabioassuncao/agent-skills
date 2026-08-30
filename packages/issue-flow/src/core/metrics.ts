/**
 * Single source of truth for translating the `claude` CLI JSON output into
 * token/cost metrics.
 *
 * Three call sites consume this (headless json, headless stream-json and the
 * execute-phase executor); keeping the parsing here is what stops them from
 * diverging again the next time the CLI payload changes shape.
 */

export interface ClaudeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  /** Envelope `duration_ms` — request onward, not process startup. */
  cliDurationMs?: number;
  /** Envelope `duration_api_ms` when the harness reports it. */
  apiDurationMs?: number;
  /** Time to first output, when the harness reports it. */
  ttftMs?: number;
  numTurns?: number;
}

/** Field names of {@link ClaudeUsage}, used by the summing helper. */
const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'costUsd',
] as const;

/**
 * Coerce a value to a finite number, or undefined when it is absent/unusable.
 * Never throws — malformed payloads simply yield undefined.
 */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse a `claude` CLI result payload into a {@link ClaudeUsage}.
 *
 * Reads the current format (`total_cost_usd` plus a nested `usage` object) and
 * falls back to the legacy flat keys (`cost_usd`, `num_input_tokens`,
 * `num_output_tokens`) when the newer ones are absent.
 *
 * Returns null when the payload carries no recognizable field at all, and a
 * partial object when only some fields are present. Never throws.
 */
/**
 * Parse a Codex `turn.completed.usage` object.
 *
 * Codex reports `input_tokens` including the cache (Decision 6 of #62), so
 * `inputTokens` is `input_tokens − cached_input_tokens`, clamped at 0. Codex
 * never reports USD; `costUsd` stays absent — "not reported", never zero.
 */
export function parseCodexUsage(payload: unknown): ClaudeUsage | null {
  if (!isRecord(payload)) return null;

  const usage: ClaudeUsage = {};
  const inputTokens = num(payload.input_tokens);
  const cachedInput = num(payload.cached_input_tokens);
  const cacheWrite = num(payload.cache_write_input_tokens);
  const outputTokens = num(payload.output_tokens);

  if (inputTokens !== undefined) {
    usage.inputTokens =
      cachedInput !== undefined ? Math.max(0, inputTokens - cachedInput) : inputTokens;
  }
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cachedInput !== undefined) usage.cacheReadTokens = cachedInput;
  if (cacheWrite !== undefined) usage.cacheCreationTokens = cacheWrite;

  return Object.keys(usage).length > 0 ? usage : null;
}

export function parseUsage(payload: unknown): ClaudeUsage | null {
  if (!isRecord(payload)) return null;

  const usageRaw = isRecord(payload.usage) ? payload.usage : undefined;

  const usage: ClaudeUsage = {};

  const inputTokens = usageRaw ? num(usageRaw.input_tokens) : undefined;
  const outputTokens = usageRaw ? num(usageRaw.output_tokens) : undefined;
  const cacheReadTokens = usageRaw ? num(usageRaw.cache_read_input_tokens) : undefined;
  const cacheCreationTokens = usageRaw ? num(usageRaw.cache_creation_input_tokens) : undefined;
  const costUsd = num(payload.total_cost_usd);

  // Legacy fallbacks — only consulted when the modern key is missing.
  const legacyInput = num(payload.num_input_tokens);
  const legacyOutput = num(payload.num_output_tokens);
  const legacyCost = num(payload.cost_usd);

  const resolvedInput = inputTokens ?? legacyInput;
  const resolvedOutput = outputTokens ?? legacyOutput;
  const resolvedCost = costUsd ?? legacyCost;

  if (resolvedInput !== undefined) usage.inputTokens = resolvedInput;
  if (resolvedOutput !== undefined) usage.outputTokens = resolvedOutput;
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens;
  if (cacheCreationTokens !== undefined) usage.cacheCreationTokens = cacheCreationTokens;
  if (resolvedCost !== undefined) usage.costUsd = resolvedCost;

  const cliDurationMs = num(payload.duration_ms);
  const apiDurationMs = num(payload.duration_api_ms);
  const ttftMs = num(payload.ttft_ms) ?? num(payload.time_to_first_token_ms);
  const numTurns = num(payload.num_turns);
  if (cliDurationMs !== undefined) usage.cliDurationMs = cliDurationMs;
  if (apiDurationMs !== undefined) usage.apiDurationMs = apiDurationMs;
  if (ttftMs !== undefined) usage.ttftMs = ttftMs;
  if (numTurns !== undefined) usage.numTurns = numTurns;

  return Object.keys(usage).length > 0 ? usage : null;
}

/**
 * Sum two usages field by field.
 *
 * `undefined` means "not reported", not zero: a field absent on both sides
 * stays absent in the result, while a field present on a single side is
 * carried over untouched.
 */
export function sumUsage(
  a: ClaudeUsage | null | undefined,
  b: ClaudeUsage | null | undefined,
): ClaudeUsage {
  const result: ClaudeUsage = {};

  for (const field of USAGE_FIELDS) {
    const left = a?.[field];
    const right = b?.[field];
    if (left === undefined && right === undefined) continue;
    result[field] = (left ?? 0) + (right ?? 0);
  }

  return result;
}

/**
 * Split a usage evenly across `parts`.
 *
 * This is the rateio used when several stories complete in the same execute
 * iteration: the iteration's tokens cannot be attributed to a single story, so
 * each one receives an equal share. Token counts are rounded to integers;
 * the cost keeps full precision.
 *
 * `parts <= 1` (or a non-finite value) returns the usage unchanged. Fields the
 * CLI never reported stay absent — dividing "not reported" still yields
 * "not reported", never zero.
 */
export function divideUsage(usage: ClaudeUsage | null | undefined, parts: number): ClaudeUsage {
  const result: ClaudeUsage = {};
  if (!usage) return result;

  const divisor = Number.isFinite(parts) && parts > 1 ? parts : 1;

  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (value === undefined) continue;
    result[field] = field === 'costUsd' ? value / divisor : Math.round(value / divisor);
  }

  return result;
}

/**
 * Compact token count: `1523` → `1.5k`, `2_400_000` → `2.4M`.
 */
function compactTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/**
 * Human-readable one-liner, e.g. `2 in / 4 out · 15.5k cache · ~$0.1607`.
 *
 * Segments whose data is missing are omitted entirely — callers can rely on an
 * empty string meaning "no metrics at all" and skip the line altogether rather
 * than printing zeros or NaN.
 */
export function formatTokens(usage: ClaudeUsage | null | undefined): string {
  if (!usage) return '';

  const segments: string[] = [];

  const io: string[] = [];
  if (usage.inputTokens !== undefined) io.push(`${compactTokens(usage.inputTokens)} in`);
  if (usage.outputTokens !== undefined) io.push(`${compactTokens(usage.outputTokens)} out`);
  if (io.length > 0) segments.push(io.join(' / '));

  const cache =
    usage.cacheReadTokens !== undefined || usage.cacheCreationTokens !== undefined
      ? (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0)
      : undefined;
  if (cache !== undefined) segments.push(`${compactTokens(cache)} cache`);

  if (usage.costUsd !== undefined) segments.push(`~$${usage.costUsd.toFixed(4)}`);

  return segments.join(' · ');
}

/**
 * True when the usage carries at least one reported field. Handy for deciding
 * whether a metrics line or event is worth emitting at all.
 */
export function hasUsageData(usage: ClaudeUsage | null | undefined): boolean {
  if (!usage) return false;
  return USAGE_FIELDS.some((field) => usage[field] !== undefined);
}
