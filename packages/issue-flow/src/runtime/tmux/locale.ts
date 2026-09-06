import { run } from '../../utils/shell.js';

/**
 * Pinning a UTF-8 locale for every tmux command.
 *
 * Ported from WebMux `backend/src/adapters/tmux.ts` @ d8c9d5f
 * (`chooseUtf8Locale`, `pickTmuxLocale`, `detectUtf8Locale`). §2.3 of the
 * absorption plan calls this one of the two defences worth more than the rest of
 * that file, and the reason is worth repeating:
 *
 * **Under a non-UTF-8 locale, tmux rewrites the TAB byte in `-F` output as `_`.**
 * Every parse of `list-windows` then produces nothing, so every window
 * disappears and every session looks closed — silently, with no error anywhere.
 * A macOS launchd agent that inherits no `LANG`/`LC_*` is exactly that case.
 */

let cachedUtf8Locale: string | null = null;

/**
 * The best UTF-8 locale from a `locale -a` listing.
 *
 * Preference order matters and is not arbitrary: a neutral `C.UTF-8` first, so
 * no locale-specific collation or messages leak into panes; then `en_US.*`;
 * then any UTF-8 locale the host reports. The *exact* listed name is returned so
 * `setlocale` accepts it — which is what keeps the fallback valid across
 * platforms, because older macOS has no `C.UTF-8` (but has `en_US.UTF-8`) and
 * minimal Linux images often have no `en_US.UTF-8` (but glibc ≥ 2.35 ships
 * `C.UTF-8`). The bare literal is only the last resort, when nothing is listed.
 */
export function chooseUtf8Locale(available: string[]): string {
  const trimmed = available.map((entry) => entry.trim()).filter(Boolean);
  const byLower = new Map(trimmed.map((entry) => [entry.toLowerCase(), entry]));
  const preferred = ['c.utf-8', 'c.utf8', 'en_us.utf-8', 'en_us.utf8'];
  return (
    preferred.map((key) => byLower.get(key)).find((entry): entry is string => Boolean(entry)) ??
    trimmed.find((entry) => /\.utf-?8$/i.test(entry)) ??
    'C.UTF-8'
  );
}

/**
 * Keep a UTF-8 locale the environment already provides; otherwise use the
 * fallback detected on the host.
 *
 * Inherited wins because a user who set `LANG=pt_BR.UTF-8` meant it, and it is
 * already UTF-8 — the substitution exists only for environments that carry none.
 */
export function pickTmuxLocale(env: Record<string, string | undefined>, fallback: string): string {
  const inherited = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return /utf-?8/i.test(inherited) ? inherited : fallback;
}

/** Best UTF-8 locale actually installed here, cached for the process lifetime. */
export async function detectUtf8Locale(): Promise<string> {
  if (cachedUtf8Locale !== null) return cachedUtf8Locale;
  let available: string[] = [];
  try {
    const result = await run('locale', ['-a'], { diagnostics: false });
    if (result.exitCode === 0) available = result.stdout.split('\n');
  } catch {
    // locale(1) unavailable — chooseUtf8Locale falls back to the literal.
  }
  cachedUtf8Locale = chooseUtf8Locale(available);
  return cachedUtf8Locale;
}

/** Test seam: the cache is process-wide and would leak between cases. */
export function resetUtf8LocaleCache(): void {
  cachedUtf8Locale = null;
}
