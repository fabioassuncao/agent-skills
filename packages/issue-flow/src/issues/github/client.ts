import { getActiveResilienceConfig } from '../../config.js';
import type { ClassifiedFailure } from '../../resilience/errors.js';
import { type PolicyConfig, resolvePolicy } from '../../resilience/policy.js';
import type { RetryPolicyFor } from '../../resilience/retry.js';
import { type ExecResult, run } from '../../utils/shell.js';

/**
 * The single `gh` invocation point of the Issue Flow GitHub integration.
 *
 * WebMux spawns `gh` from four different services, each rebuilding its own
 * timeout race. Here every call goes through `run()` — the project's shell
 * chokepoint — with argv, never a shell string, and carries the resilience
 * policy of the failure it actually hits (§45.3: the retry taxonomy is a
 * guarantee the port must not lose).
 */

/**
 * Hard ceiling for a `gh` call, matching WebMux's `GH_TIMEOUT_MS`.
 *
 * WebMux races `proc.exited` against `Bun.sleep` and kills the child; execa's
 * `timeout` does the same thing, and `run()` reports the timeout as a
 * classified failure instead of a bare non-zero exit.
 */
export const GH_TIMEOUT_MS = 15_000;

/**
 * Every `gh` invocation carries the resilience policy of the failure it hits:
 * the `network` budget for a DNS blip, the `rate_limit` budget (and the
 * server's `Retry-After`) for a rate limit, and — because `resolvePolicy()`
 * clamps them — **no** attempt at all for an authentication or configuration
 * failure. This is the one place `gh` failures stop being fatal on sight.
 */
export function ghPolicy(): RetryPolicyFor {
  return (failure: ClassifiedFailure) =>
    resolvePolicy(failure.kind, getActiveResilienceConfig() as PolicyConfig);
}

/**
 * The budget of the availability probes, capped well below the full one.
 *
 * A probe answers a question about liveness; the answer must not take minutes.
 * The real read (`get`, `create`, `close`) keeps the full policy, so a blip
 * during the work is still absorbed at its documented budget — what is capped
 * here is only how long an *unreachable* GitHub delays a `local` Issue that
 * would have resolved instantly.
 */
export const PROBE_MAX_ATTEMPTS = 3;
export const PROBE_MAX_DELAY_MS = 5_000;

export function ghProbePolicy(): RetryPolicyFor {
  const policyFor = ghPolicy();
  return (failure) => {
    const policy = policyFor(failure);
    return {
      ...policy,
      maxAttempts: Math.min(policy.maxAttempts, PROBE_MAX_ATTEMPTS),
      maxDelayMs: Math.min(policy.maxDelayMs, PROBE_MAX_DELAY_MS),
      retryForever: false,
    };
  };
}

export interface GhOptions {
  /** Directory the call runs in; omitted means the current working directory. */
  cwd?: string;
  /** Per-call ceiling. Omitted means no timeout, as the Issue reads have always run. */
  timeout?: number;
}

/** `gh <args>` under the full resilience policy. */
export function gh(args: string[], options: GhOptions = {}): Promise<ExecResult> {
  return run('gh', args, {
    retry: ghPolicy(),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
}

/** `gh <args>` under the full policy and the 15 s ceiling the monitors use. */
export function ghBounded(args: string[], options: GhOptions = {}): Promise<ExecResult> {
  return gh(args, { timeout: GH_TIMEOUT_MS, ...options });
}
