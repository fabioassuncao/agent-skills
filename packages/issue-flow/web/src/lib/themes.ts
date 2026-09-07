import type { ITheme } from '@xterm/xterm';

export const THEME_KEYS = [
  'system',
  'light',
  'dark',
  'github-dark',
  'dracula',
  'nord',
  'solarized-dark',
  'one-dark',
] as const;
export type ThemeKey = (typeof THEME_KEYS)[number];

export const THEME_LABELS: Record<ThemeKey, string> = {
  system: 'Sistema',
  light: 'Claro',
  dark: 'Escuro',
  'github-dark': 'GitHub Dark',
  dracula: 'Dracula',
  nord: 'Nord',
  'solarized-dark': 'Solarized Dark',
  'one-dark': 'One Dark',
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
