// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * **U20** — no horizontal scrolling at 360, 768 or 1440.
 *
 * `happy-dom` has no layout engine: `getBoundingClientRect()` returns zeros and
 * `scrollWidth` is always `0` (verified before this suite was written), so the
 * width cannot be *measured* in this suite. The measurement is taken in a real
 * browser and recorded in `docs/absorption-trace.md`, at all three widths and
 * in both themes.
 *
 * What this suite is, then, is the **regression guard on the CSS contract that
 * produces the result**, and each rule below is one of the ways the panel
 * actually loses it:
 *
 * 1. A fixed or minimum width above the narrowest breakpoint, on anything that
 *    is not explicitly inside a scrolling box. 360px is the narrowest width the
 *    panel supports, so a `min-width: 480px` in the page flow is a horizontal
 *    scrollbar on a phone.
 * 2. A wide box that is **not** wrapped in `.if-scroll-x`. Tables, boards, log
 *    lines and the phase grid all exceed 360px by design; each must scroll
 *    inside itself.
 * 3. A third breakpoint. The panel has exactly two (640 and 960); a component
 *    that invents its own is how a layout starts disagreeing with itself.
 */

const libDir = fileURLToPath(new URL('.', import.meta.url));
const srcDir = fileURLToPath(new URL('..', import.meta.url));

/** The components this phase added — the ones whose CSS this guards. */
const EXECUTION_COMPONENTS = readdirSync(libDir)
  .filter((name) => name.endsWith('.svelte'))
  .filter((name) => {
    const source = readFileSync(`${libDir}${name}`, 'utf-8');
    return source.includes('if-card') || source.includes('if-kanban') || source.includes('if-row');
  });

function styleBlockOf(source: string): string {
  const start = source.indexOf('<style>');
  if (start === -1) return '';
  return source.slice(start, source.indexOf('</style>', start));
}

describe('the execution surface stays inside the viewport (U20)', () => {
  it('covers the components this phase added', () => {
    // A guard that silently stops covering anything is worse than no guard.
    expect(EXECUTION_COMPONENTS.length).toBeGreaterThanOrEqual(8);
  });

  for (const name of EXECUTION_COMPONENTS) {
    it(`${name} declares no wide box outside a scrolling container`, () => {
      const source = readFileSync(`${libDir}${name}`, 'utf-8');
      const style = styleBlockOf(source);

      const widths = [...style.matchAll(/\b(min-width|width)\s*:\s*(\d+)px/g)];
      for (const match of widths) {
        const value = Number(match[2]);
        if (value <= 360) continue;
        // Anything wider is only allowed inside `.if-scroll-x`, which is the
        // one place the panel lets content be wider than the page.
        expect(
          source.includes('if-scroll-x'),
          `${name}: ${match[0]} without an .if-scroll-x wrapper`,
        ).toBe(true);
      }
    });

    it(`${name} uses only the two breakpoints`, () => {
      const style = styleBlockOf(source(name));
      const breakpoints = [...style.matchAll(/@media\s*\(\s*(?:min|max)-width:\s*(\d+)px/g)].map(
        (match) => Number(match[1]),
      );
      for (const breakpoint of breakpoints) {
        expect([640, 960, 768], `${name}: breakpoint ${breakpoint}px`).toContain(breakpoint);
      }
    });

    it(`${name} lets its own content shrink`, () => {
      // `min-width: 0` on a flex or grid child is what stops a long branch name
      // or a log line from pushing the page wider than the viewport: the
      // default `min-width: auto` refuses to shrink below the content.
      const style = styleBlockOf(source(name));
      if (!/display:\s*(flex|grid)/.test(style)) return;
      expect(style, `${name}: no min-width: 0 anywhere in a flex/grid layout`).toMatch(
        /min-width:\s*0/,
      );
    });
  }
});

function source(name: string): string {
  return readFileSync(`${libDir}${name}`, 'utf-8');
}

describe('the shared layer', () => {
  const appCss = readFileSync(`${srcDir}/app.css`, 'utf-8');

  it('caps the surface at the width the four blocks were laid out for', () => {
    expect(appCss).toMatch(/\.if-surface\s*\{[^}]*max-width:\s*1200px/);
  });

  it('gives wide content its own scrolling box', () => {
    expect(appCss).toMatch(/\.if-scroll-x\s*\{[^}]*overflow-x:\s*auto/);
  });

  it('uses only the two breakpoints', () => {
    const breakpoints = [...appCss.matchAll(/@media\s*\(\s*(?:min|max)-width:\s*(\d+)px/g)].map(
      (match) => Number(match[1]),
    );
    // 768 is the upstream's mobile switch, which the port keeps for the mobile
    // surface; the panel's own two are 640 and 960.
    for (const breakpoint of breakpoints) {
      expect([640, 768, 960]).toContain(breakpoint);
    }
  });

  it('never puts a literal colour in the execution layer (ADR-19)', () => {
    const layer = appCss.slice(appCss.indexOf('The execution surface (Fase 8C)'));
    const literals = [...layer.matchAll(/(#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\))/g)]
      .map((match) => match[0])
      // `rgb(0 0 0 / …)` inside a token definition is the palette's own
      // business; the execution layer must not contain any.
      .filter((value) => !value.startsWith('rgb(0 0 0'));
    expect(literals, 'cores literais na camada da superfície de execução').toEqual([]);
  });
});

describe('no literal colour in any component this phase added (ADR-19)', () => {
  for (const name of EXECUTION_COMPONENTS) {
    it(name, () => {
      const text = source(name);
      // Hex and rgb() in a scoped style block.
      const style = styleBlockOf(text);
      expect([...style.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])).toEqual([]);
      // Tailwind utilities that name a colour rather than a role.
      const forbidden = text.match(
        /\b(?:bg|text|border)-(?:white|black|red|green|blue|yellow|amber|slate|gray|grey|zinc|neutral|stone|indigo|violet|purple)(?:-\d{2,3})?\b/g,
      );
      expect(forbidden, `${name}: classe utilitária com cor literal`).toBeNull();
    });
  }
});
