/**
 * Shared merge helpers for the configuration precedence ladder.
 * See docs/configuration.md. Domains import from here only.
 */

export interface ConfigLayers<T extends object> {
  /** Hard-coded fallbacks, e.g. DEFAULTS or the values baked into a schema. */
  defaults?: Partial<T>;
  /**
   * Values read from the consumer repository itself — the policies discovered
   * by `src/policy/`. They sit just above the defaults: a repository's own
   * convention beats a fallback Issue Flow invented, and loses to anything the
   * user explicitly configured.
   */
  discovered?: Partial<T>;
  /** ~/.issue-flow/config.json, via loadGlobalConfig(). */
  global?: Partial<T>;
  /** The matching key of .issue-flow.json in the project root. */
  project?: Partial<T>;
  /** ISSUE_FLOW_* environment variables. */
  env?: Partial<T>;
  /** CLI flags. */
  cli?: Partial<T>;
}

/**
 * Merge configuration layers following the documented precedence.
 *
 * Pure and shallow: a layer only participates with the keys it actually
 * carries, so an absent key never erases the layer below it. `undefined` counts
 * as absent — that is what lets a layer be built by assigning only the values
 * that were really provided.
 *
 * Because the merge is shallow, nested objects (`web`, `retry`) are replaced
 * whole rather than merged field by field; callers that need per-field
 * precedence inside a nested key must flatten it into its own merge.
 *
 * Caveat for the `project` layer: it must be the *raw* set of keys the user
 * wrote, not the output of a schema that materializes defaults. In zod 4 a
 * `.default()` survives `.partial()`, so parsing the project file with
 * `webConfigSchema.partial()` yields every default and would make the project
 * layer swallow the global one.
 */
export function mergeConfigLayers<T extends object>(layers: ConfigLayers<T>): Partial<T> {
  const merged: Record<string, unknown> = {};

  for (const layer of [
    layers.defaults,
    layers.discovered,
    layers.global,
    layers.project,
    layers.env,
    layers.cli,
  ]) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }

  return merged as Partial<T>;
}

/**
 * Drop the keys a layer left as `null` or `undefined`.
 *
 * `mergeConfigLayers` only treats `undefined` as "absent", and the input schema
 * accepts `null` as the natural way to write "I do not declare this" — without
 * this, a `"baseBranch": null` would win over the branch discovery found.
 */
export function dropNullish<T extends object>(layer: T | undefined): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(layer ?? {})) {
    if (value !== undefined && value !== null) {
      result[key] = value;
    }
  }
  return result as Partial<T>;
}

const FALSY_ENV_VALUES = new Set(['', '0', 'false', 'no', 'off']);

export function parseBooleanEnv(value: string): boolean {
  return !FALSY_ENV_VALUES.has(value.trim().toLowerCase());
}

export function readNumberEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  warn: (message: string) => void,
): number | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    warn(`Ignoring ${name}="${raw}": not a number.`);
    return undefined;
  }
  return parsed;
}
