import type { ITheme } from '@xterm/xterm';

/**
 * ADAPT of `frontend/src/lib/themes.ts` @ d8c9d5f (151 lines).
 *
 * The upstream ships five hard-coded palettes (GitHub Dark, Dracula, Nord,
 * Solarized Dark, One Dark), each a block of literal hex values, and the
 * "theme" is which of the five is copied onto `--color-*` at runtime.
 *
 * That model is **not** ported, and the reason is not taste: the Issue Flow
 * palette is eighteen calculated contrast pairs (`web/AGENTS.md`), and five
 * alternative palettes would be five more tables nobody measured — the panel
 * would ship four themes whose badge text is somewhere between 2:1 and 5:1 and
 * nobody would know which. The current panel's decision stands instead: three
 * options, `system` / `light` / `dark`, over one measured palette.
 *
 * What survives from the upstream is the shape — a resolved theme object that
 * feeds xterm — and it is now *derived* from the same tokens the rest of the
 * page uses, rather than duplicated beside them.
 */

export const THEME_KEYS = ['system', 'light', 'dark'] as const;
export type ThemeKey = (typeof THEME_KEYS)[number];

export const THEME_LABELS: Record<ThemeKey, string> = {
  system: 'Sistema',
  light: 'Claro',
  dark: 'Escuro',
};

export interface ThemeDefinition {
  key: ThemeKey;
  label: string;
}

export const THEMES: ThemeDefinition[] = THEME_KEYS.map((key) => ({
  key,
  label: THEME_LABELS[key],
}));

export function isThemeKey(value: unknown): value is ThemeKey {
  return typeof value === 'string' && (THEME_KEYS as readonly string[]).includes(value);
}

export function getTheme(key: string): ThemeDefinition {
  return THEMES.find((theme) => theme.key === key) ?? THEMES[0];
}

/**
 * Read one role token as it actually resolved on the page.
 *
 * From the current panel's verification rule: measure the cascade, never the
 * file. A token a theme inherits from the other by mistake is only visible
 * here, and reading the file would report the value that was *meant*.
 */
function readToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

/**
 * The xterm palette, taken from the resolved page tokens.
 *
 * Called after a theme change rather than memoised: the values it reads are the
 * ones the browser just recomputed, and caching them is how a terminal ends up
 * the only element still painted in the previous theme.
 */
export function terminalThemeFromTokens(): ITheme {
  return {
    background: readToken('--surface', '#ffffff'),
    foreground: readToken('--text', '#1a1f27'),
    cursor: readToken('--accent', '#4f46e5'),
    selectionBackground: readToken('--state-run-surface', '#dbeafe'),
  };
}
