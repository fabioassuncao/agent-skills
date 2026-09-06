/**
 * WCAG 2.x contrast, computed from the tokens **as the page resolved them**.
 *
 * `web/AGENTS.md` states the rule this module exists to make executable:
 *
 * > Para medir contraste, **meça na página** (ler os tokens com
 * > `getComputedStyle(document.documentElement)` e calcular a razão em JS),
 * > nunca a partir dos valores no arquivo: só assim a cascata resolvida
 * > aparece, incluindo o token que um tema herda do outro por engano.
 *
 * So this file never contains a colour. It reads the resolved value of a custom
 * property and computes the ratio — which is what makes the recorded table a
 * measurement rather than a claim, and what catches the token a theme inherits
 * from the other by mistake.
 */

export interface ContrastPair {
  /** Foreground role token, e.g. `--text`. */
  foreground: string;
  /** Background role token, e.g. `--surface-page`. */
  background: string;
  /**
   * 4.5 for text, 3 for a graphic component.
   *
   * The state badges are held to 4.5 and not 3 because `.badge` is
   * `--font-size-sm` at weight 600, below what WCAG calls large text.
   * `--focus-ring` is a graphic component, not text: 3 is enough.
   */
  minimum: number;
}

/**
 * The pairs the palette is measured on.
 *
 * Nineteen: the panel's original eighteen plus `--state-merged`, the role the
 * new panel needed and the palette did not have. **Changing any of these tokens
 * means recomputing its row** — most of the light palette passes with little
 * headroom.
 */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { foreground: '--text', background: '--surface-page', minimum: 4.5 },
  { foreground: '--text', background: '--surface', minimum: 4.5 },
  { foreground: '--text', background: '--surface-sunken', minimum: 4.5 },
  { foreground: '--text-muted', background: '--surface-page', minimum: 4.5 },
  { foreground: '--text-muted', background: '--surface', minimum: 4.5 },
  { foreground: '--text-muted', background: '--surface-sunken', minimum: 4.5 },
  { foreground: '--text-subtle', background: '--surface-page', minimum: 4.5 },
  { foreground: '--text-subtle', background: '--surface', minimum: 4.5 },
  { foreground: '--text-subtle', background: '--surface-sunken', minimum: 4.5 },
  { foreground: '--state-ok', background: '--state-ok-surface', minimum: 4.5 },
  { foreground: '--state-run', background: '--state-run-surface', minimum: 4.5 },
  { foreground: '--state-warn', background: '--state-warn-surface', minimum: 4.5 },
  { foreground: '--state-error', background: '--state-error-surface', minimum: 4.5 },
  { foreground: '--state-merged', background: '--state-merged-surface', minimum: 4.5 },
  { foreground: '--focus-ring', background: '--surface-page', minimum: 3 },
  { foreground: '--focus-ring', background: '--surface', minimum: 3 },
  { foreground: '--focus-ring', background: '--surface-sunken', minimum: 3 },
  { foreground: '--accent-text', background: '--accent', minimum: 4.5 },
  { foreground: '--accent-text', background: '--state-error', minimum: 4.5 },
];

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rgb`, `#rrggbb` and `rgb(r g b)` / `rgb(r, g, b)`, which is what browsers return. */
export function parseColor(value: string): Rgb | null {
  const input = value.trim();
  if (input === '') return null;

  const hex = input.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1];
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((digit) => digit + digit)
            .join('')
        : digits;
    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
    };
  }

  const rgb = input.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }
  return null;
}

/** WCAG relative luminance. */
export function relativeLuminance(color: Rgb): number {
  const channel = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

export function contrastRatio(foreground: Rgb, background: Rgb): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface MeasuredPair extends ContrastPair {
  ratio: number;
  passes: boolean;
}

export type TokenReader = (name: string) => string;

/** Read the resolved value of a role token from the document root. */
export function documentTokenReader(root: HTMLElement = document.documentElement): TokenReader {
  const computed = getComputedStyle(root);
  return (name) => computed.getPropertyValue(name).trim();
}

/**
 * Measure every pair with the given reader.
 *
 * A token that resolves to nothing (or to something this cannot parse) is
 * reported as ratio `0`, which fails: an unreadable token is not a pass, and
 * silently skipping it is how a palette stops being measured without anybody
 * noticing.
 */
export function measureContrast(read: TokenReader): MeasuredPair[] {
  return CONTRAST_PAIRS.map((pair) => {
    const foreground = parseColor(read(pair.foreground));
    const background = parseColor(read(pair.background));
    const ratio =
      foreground === null || background === null ? 0 : contrastRatio(foreground, background);
    return { ...pair, ratio, passes: ratio >= pair.minimum };
  });
}

/** Two decimals, comma-separated, the way `web/AGENTS.md` records them. */
export function formatRatio(ratio: number): string {
  return ratio.toFixed(2).replace('.', ',');
}
