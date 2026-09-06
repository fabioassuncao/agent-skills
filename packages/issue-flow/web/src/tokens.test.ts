// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The palette guard.
 *
 * ADDITION over the upstream, and the reason ADR-19 can be stated as a fact
 * rather than a hope: `src/tokens.css` is a copy of the palette layer of
 * `web/public/app.css`, and while both panels exist (ADR-18) nothing else
 * prevents the two from drifting. A drift is invisible — the new panel simply
 * renders slightly different colours, and the eighteen measured contrast pairs
 * quietly stop describing it.
 *
 * This test is what makes the drift loud. When the legacy palette changes,
 * `tokens.css` has to be regenerated from it:
 *
 *     sed -n '1,153p' web/public/app.css > web/src/tokens.css
 */

// This suite reads files, not a DOM, so it runs under the node environment —
// which is also what makes `import.meta.url` a `file:` URL here.
const legacyPath = fileURLToPath(new URL('../public/app.css', import.meta.url));
const tokensPath = fileURLToPath(new URL('./tokens.css', import.meta.url));

/** Everything up to and including the forced-dark block. */
const PALETTE_END = "\n:root[data-theme='dark'] {";

function paletteLayerOf(css: string): string {
  const start = css.indexOf(PALETTE_END);
  expect(start, 'the forced-dark twin block must exist').toBeGreaterThan(-1);
  const end = css.indexOf('\n}\n', start);
  expect(end, 'the forced-dark twin block must be closed').toBeGreaterThan(start);
  return css.slice(0, end + 3);
}

describe('colour tokens', () => {
  const legacy = readFileSync(legacyPath, 'utf-8');
  const tokens = readFileSync(tokensPath, 'utf-8');

  it('is a verbatim copy of the palette layer of the legacy panel', () => {
    expect(tokens).toBe(paletteLayerOf(legacy));
  });

  it('declares every role token in :root, never only in a theme block', () => {
    // The current panel's hard rule: a token whose only definition lives inside
    // a `@media` or a `[data-theme]` disappears in the other theme, and the
    // symptom shows up far from the cause.
    const rootBlock = tokens.slice(tokens.indexOf(':root {'), tokens.indexOf('\n}\n'));
    const rootTokens = new Set(
      [...rootBlock.matchAll(/^\s{2}(--[a-z0-9-]+):/gm)].map((match) => match[1]),
    );
    const allTokens = new Set(
      [...tokens.matchAll(/^\s+(--[a-z0-9-]+):/gm)].map((match) => match[1]),
    );

    for (const token of allTokens) {
      expect(rootTokens, `${token} is only defined inside a theme block`).toContain(token);
    }
  });

  it('keeps the two dark blocks carrying the same overrides', () => {
    // "Mexeu em um, mexa no outro" — the media-query block and the forced block
    // are twins, and a token in only one of them makes the manual theme differ
    // from the system one.
    const mediaBlock = tokens.slice(
      tokens.indexOf(":root:not([data-theme='light']) {"),
      tokens.indexOf(PALETTE_END),
    );
    const forcedBlock = tokens.slice(tokens.indexOf(PALETTE_END));

    // The media block is nested one level deeper, so indentation is not the
    // discriminator here — any declaration line is.
    const namesOf = (block: string) =>
      [...block.matchAll(/^\s+(--[a-z0-9-]+):/gm)].map((match) => match[1]).sort();

    expect(namesOf(forcedBlock)).toEqual(namesOf(mediaBlock));
  });
});
