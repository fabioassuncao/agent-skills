// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTRAST_PAIRS,
  contrastRatio,
  formatRatio,
  measureContrast,
  parseColor,
  relativeLuminance,
} from './contrast';
import { THEME_KEYS, type ThemeKey } from './themes';

const tokensCss = readFileSync(fileURLToPath(new URL('../tokens.css', import.meta.url)), 'utf-8');

/**
 * `app.css` consumes the roles through Tailwind. It must not declare palette
 * values: all nineteen measured roles, including `--state-merged`, live in
 * `tokens.css` so a named palette cannot be partially overridden later in the
 * cascade.
 */
const appCss = readFileSync(fileURLToPath(new URL('../app.css', import.meta.url)), 'utf-8');

/** Resolve the palette the way the cascade does: `:root`, then the theme. */
function resolveTokens(theme: Exclude<ThemeKey, 'system'>): (name: string) => string {
  const values = new Map<string, string>();

  const readBlock = (block: string): void => {
    for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      values.set(match[1], match[2].trim());
    }
  };

  // `:root` carries the whole light palette — that is the hard rule.
  const rootStart = tokensCss.indexOf(':root {');
  const rootEnd = tokensCss.indexOf('\n}\n', rootStart);
  readBlock(tokensCss.slice(rootStart, rootEnd));

  if (theme !== 'light') {
    const forcedStart = tokensCss.indexOf(`:root[data-theme='${theme}'] {`);
    const forcedEnd = tokensCss.indexOf('\n}\n', forcedStart);
    readBlock(tokensCss.slice(forcedStart, forcedEnd));
  }

  // Same cascade, over the file that declares the merged role.
  const appRootStart = appCss.indexOf(':root {');
  readBlock(appCss.slice(appRootStart, appCss.indexOf('\n}\n', appRootStart)));
  if (theme !== 'light') {
    const appForcedStart = appCss.indexOf(`:root[data-theme='${theme}'] {`);
    if (appForcedStart < 0) return (name) => values.get(name) ?? '';
    readBlock(appCss.slice(appForcedStart, appCss.indexOf('\n}\n', appForcedStart)));
  }

  return (name) => values.get(name) ?? '';
}

describe('the contrast maths', () => {
  it('parses hex and the rgb() form a browser returns', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('#1a1f27')).toEqual({ r: 26, g: 31, b: 39 });
    expect(parseColor('rgb(26, 31, 39)')).toEqual({ r: 26, g: 31, b: 39 });
    expect(parseColor('rgb(26 31 39)')).toEqual({ r: 26, g: 31, b: 39 });
    expect(parseColor('')).toBeNull();
    expect(parseColor('var(--nope)')).toBeNull();
  });

  it('computes the WCAG reference ratio', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 5);
  });

  it('fails an unreadable token instead of skipping it', () => {
    // A token that resolves to nothing is not a pass. Skipping it is how a
    // palette stops being measured without anybody noticing.
    const measured = measureContrast(() => '');
    expect(measured.every((pair) => pair.ratio === 0 && !pair.passes)).toBe(true);
  });
});

describe('the palette (U19)', () => {
  const explicitThemes = THEME_KEYS.filter(
    (theme): theme is Exclude<ThemeKey, 'system'> => theme !== 'system',
  );

  for (const theme of explicitThemes) {
    it(`meets every minimum in the ${theme} theme`, () => {
      const measured = measureContrast(resolveTokens(theme));
      expect(measured).toHaveLength(19);

      const failures = measured
        .filter((pair) => !pair.passes)
        .map(
          (pair) =>
            `${pair.foreground} on ${pair.background}: ${formatRatio(pair.ratio)} < ${pair.minimum}`,
        );
      expect(failures, `pares abaixo do mínimo no tema ${theme}`).toEqual([]);
    });
  }

  it('measures every explicit theme, so a token cannot pass in one and vanish in another', () => {
    for (const theme of explicitThemes) {
      const read = resolveTokens(theme);
      for (const pair of CONTRAST_PAIRS) {
        expect(parseColor(read(pair.foreground)), `${pair.foreground} (${theme})`).not.toBeNull();
        expect(parseColor(read(pair.background)), `${pair.background} (${theme})`).not.toBeNull();
      }
    }
  });

  it('keeps all palette values out of app.css', () => {
    expect(appCss).not.toMatch(/--(?:surface|text|state|accent|focus-ring|border)[a-z-]*\s*:/);
  });
});
