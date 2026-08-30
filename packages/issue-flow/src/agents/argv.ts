/**
 * Shared argv helpers. An empty or absent list leaves `args` untouched, so
 * callers that pass nothing keep the exact same argv they had before.
 */

export function pushRepeatedFlag(args: string[], flag: string, values: string[] | undefined): void {
  if (!values || values.length === 0) return;
  for (const value of values) {
    args.push(flag, value);
  }
}

/** Format a `-c key=value` TOML literal for Codex. */
export function formatCodexConfigValue(value: string | number | boolean): string {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (/^[A-Za-z0-9_.-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
