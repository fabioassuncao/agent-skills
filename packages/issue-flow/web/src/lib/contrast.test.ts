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

/**
 * **U19** — the nineteen pairs, recomputed, never repeated from the table.
 *
 * `web/AGENTS.md` says to measure **on the page**: read the tokens with
 * `getComputedStyle(document.documentElement)` and compute the ratio in JS, so
 * the resolved cascade is what is measured — including a token one theme
 * inherits from the other by mistake.
 *
 * `happy-dom` has no CSS cascade and no layout: `getComputedStyle` returns an
 * empty string for every custom property (verified before this suite was
 * written). So the cascade is resolved here the way the browser would, from
 * `tokens.css` itself, and this suite is the **regression guard**; the
 * measurement on a real page is recorded in `docs/absorption-trace.md`, taken
 * with `measureContrast(documentTokenReader())` in a browser — the same
 * function, the same pairs, a real cascade.
 *
 * What this catches is what actually breaks: a token changed without its row
 * being recomputed, a token defined only inside a theme block, and a pair that
 * drops below its minimum.
 *
 * It runs under the **node** environment, like `tokens.test.ts` and for the
 * same reason: it reads files. `import '../tokens.css?raw'` is not an option —
 * the Tailwind Vite plugin claims every `.css` import and hands back an empty
 * string.
 */

const tokensCss = readFileSync(fileURLToPath(new URL('../tokens.css', import.meta.url)), 'utf-8');

/**
 * `--state-merged` is declared in `app.css`, not in `tokens.css`.
 *
 * `tokens.css` is a **verbatim** copy of the legacy panel's palette layer
 * (`tokens.test.ts` fails if it drifts), and the legacy palette has no role for
 * an integrated pull request. So the role the new panel needed lives beside the
 * comment explaining why, and is read from there — from the file, never from a
 * copy of the numbers.
 */
const appCss = readFileSync(fileURLToPath(new URL('../app.css', import.meta.url)), 'utf-8');

/** Resolve the palette the way the cascade does: `:root`, then the theme. */
function resolveTokens(theme: 'light' | 'dark'): (name: string) => string {
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

  if (theme === 'dark') {
    const forcedStart = tokensCss.indexOf(":root[data-theme='dark'] {");
    const forcedEnd = tokensCss.indexOf('\n}\n', forcedStart);
    readBlock(tokensCss.slice(forcedStart, forcedEnd));
  }

  // Same cascade, over the file that declares the merged role.
  const appRootStart = appCss.indexOf(':root {');
  readBlock(appCss.slice(appRootStart, appCss.indexOf('\n}\n', appRootStart)));
  if (theme === 'dark') {
    const appForcedStart = appCss.indexOf(":root[data-theme='dark'] {");
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
  for (const theme of ['light', 'dark'] as const) {
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

  it('measures both themes, so a token cannot pass in one and vanish in the other', () => {
    for (const theme of ['light', 'dark'] as const) {
      const read = resolveTokens(theme);
      for (const pair of CONTRAST_PAIRS) {
        expect(parseColor(read(pair.foreground)), `${pair.foreground} (${theme})`).not.toBeNull();
        expect(parseColor(read(pair.background)), `${pair.background} (${theme})`).not.toBeNull();
      }
    }
  });
});
