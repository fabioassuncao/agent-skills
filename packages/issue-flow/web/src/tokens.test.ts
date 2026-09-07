// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The palette's two structural rules.
 *
 * ADDITION over the upstream, and the reason ADR-19 can be stated as a fact
 * rather than a hope.
 *
 * **What changed in phase 8D.** This suite used to open with a drift guard:
 * `tokens.css` had to be a verbatim copy of the palette layer of
 * `web/public/app.css`, because while both panels existed (ADR-18) nothing else
 * kept them from diverging. §50.8 removed that panel, so there is one palette
 * and nothing left to drift from — the case went with the file it was guarding.
 * What it was ultimately protecting is stronger and still here:
 * `lib/contrast.test.ts` recalculates the nineteen measured pairs from
 * `tokens.css` and `app.css` themselves, never from the table.
 *
 * The two rules below are about `tokens.css` on its own and are unchanged: a
 * token defined only inside a theme block, and the two dark blocks disagreeing,
 * are both failures whose symptom appears far from their cause.
 */

// This suite reads files, not a DOM, so it runs under the node environment —
// which is also what makes `import.meta.url` a `file:` URL here.
const tokensPath = fileURLToPath(new URL('./tokens.css', import.meta.url));

function declarationBlock(source: string, selector: string): string {
  const start = source.indexOf(selector);
  if (start < 0) return '';
  const bodyStart = source.indexOf('{', start) + 1;
  const end = source.indexOf('\n}', bodyStart);
  return source.slice(bodyStart, end);
}

describe('colour tokens', () => {
  const tokens = readFileSync(tokensPath, 'utf-8');

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
    const mediaBlock = declarationBlock(tokens, ":root:not([data-theme='light']) {");
    const forcedBlock = declarationBlock(tokens, ":root[data-theme='dark'] {");

    // The media block is nested one level deeper, so indentation is not the
    // discriminator here — any declaration line is.
    const namesOf = (block: string) =>
      [...block.matchAll(/^\s+(--[a-z0-9-]+):/gm)].map((match) => match[1]).sort();

    expect(namesOf(forcedBlock)).toEqual(namesOf(mediaBlock));
  });
});
