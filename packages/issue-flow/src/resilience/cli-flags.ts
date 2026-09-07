import { DEFAULT_INACTIVITY_TIMEOUT_MS } from '../core/watchdog.js';
import type { ResilienceConfig } from '../storage/schemas.js';

/**
 * The resilience flags, turned into the CLI rung of the configuration ladder.
 *
 * Kept out of `cli.ts` (which runs `program.parse()` on import) so the mapping
 * is testable on its own, the same reason `cli-options.ts` and
 * `issues/cli-flags.ts` live outside it.
 *
 * **`--continuous` is a profile, not a mechanism.** Long autonomous work needs
 * about six behaviours turned on at once, and asking for six flags is asking
 * for five of them to be forgotten. So the profile names the *intent* — "keep
 * going without me" — and expands to the settings that intent implies, every
 * one of which stays adjustable on its own.
 */

export interface ResilienceFlags {
  /** `--continuous` / `--resilient`: the long-running profile. */
  continuous?: boolean;
  resilient?: boolean;
  /** `--no-failover`: never migrate a phase to another provider. */
  failover?: boolean;
  /** `--auto-decompose`: act on a decomposition report instead of reporting. */
  autoDecompose?: boolean;
  /** `--inactivity-timeout <seconds>`: the watchdog budget. */
  inactivityTimeout?: number;
  /** `--on-issue-failure <mode>`: what a failing issue does to the queue. */
  onIssueFailure?: 'stop' | 'skip' | 'block';
}

/**
 * What `--continuous` turns on.
 *
 * The retry side is the `continuous` **profile** of `resolvePolicy()` — network
 * and rate limits retried forever, wider budgets for the rest — rather than a
 * list of numbers repeated here, so the two cannot drift. The rest is what the
 * profile implies at the pipeline level: keep the queue moving and notice an
 * agent that has gone quiet. Execution events are always persisted in SQLite.
 */
function continuousProfile(): ResilienceConfig {
  return {
    profile: 'continuous',
    providers: { failover: true },
    queue: { onIssueFailure: 'skip' },
    watchdog: { inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS },
  };
}

/**
 * Resolve the flags into one `resilience` object.
 *
 * The profile is applied first and the granular flags on top of it, which is
 * the whole precedence rule: **an explicit flag always beats the profile**.
 * `--continuous --no-failover` is a coherent thing to ask for and means exactly
 * what it says.
 */
export function resolveResilienceOverrides(flags: ResilienceFlags): ResilienceConfig {
  const continuous = flags.continuous === true || flags.resilient === true;
  const overrides: ResilienceConfig = continuous ? continuousProfile() : {};

  // Commander maps `--no-failover` to `failover: false`, and leaves the field
  // absent when the flag was not passed — so `false` here is always explicit.
  if (flags.failover === false) {
    overrides.providers = { ...overrides.providers, failover: false };
  }
  if (flags.autoDecompose === true) {
    overrides.decompose = { ...overrides.decompose, auto: true };
  }
  if (flags.inactivityTimeout !== undefined) {
    overrides.watchdog = {
      ...overrides.watchdog,
      inactivityTimeoutMs: flags.inactivityTimeout * 1000,
    };
  }
  if (flags.onIssueFailure !== undefined) {
    overrides.queue = { ...overrides.queue, onIssueFailure: flags.onIssueFailure };
  }

  return overrides;
}
