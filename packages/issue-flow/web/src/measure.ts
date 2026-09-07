import { mount } from 'svelte';
import './app.css';
import { documentTokenReader, measureContrast } from './lib/contrast';
import ExecutionPanel from './lib/ExecutionPanel.svelte';
import { createExecutionSnapshot } from './lib/execution-fixtures';
import type { ThemeKey } from './lib/themes';

/**
 * The measurement harness for U6, U19 and U20.
 *
 * `happy-dom` has no CSS cascade and no layout, so three of the panel's
 * acceptance criteria cannot be measured in the vitest suite: the contrast of
 * the resolved tokens, the absence of horizontal scrolling at 360/768/1440, and
 * "Estado agora" fitting without scrolling at 1440×900 with the alerts card
 * open. This page mounts the execution surface with the same fixture the suite
 * uses, against nothing but the DOM — no server, no API — so those three can be
 * taken in a real browser.
 *
 * Run it with `npm run dev:web` and open `/measure.html`; the numbers are read
 * from `window.measure*`. It is a development harness and is not part of the
 * shipped panel: `web/measure.html` is not `web/index.html`, and the panel's
 * own entry does not import it.
 */

const target = document.getElementById('app');
if (target !== null) {
  mount(ExecutionPanel, {
    target,
    props: {
      snapshot: createExecutionSnapshot(),
      now: Date.now(),
      events: [
        { seq: 1, event: { type: 'phase:start', at: new Date().toISOString(), phase: 'execute' } },
      ],
      diagnostics: [],
      config: null,
      monitorVersion: '0.20.0',
      canEditPreferences: false,
      refreshSeconds: 5,
      activeTab: 'execution',
      logFilter: 'all' as const,
      historyFilter: 'all' as const,
      drawer: null,
      onrefreshchange: () => {},
      ontabchange: () => {},
      onlogfilterchange: () => {},
      onhistoryfilterchange: () => {},
      onopendrawer: () => {},
      onclosedrawer: () => {},
      onopensettings: () => {},
    },
  });
}

declare global {
  interface Window {
    measureContrastPairs(theme: Exclude<ThemeKey, 'system'>): unknown;
    measureHorizontalOverflow(): unknown;
    measureNowBlock(): unknown;
  }
}

/** U19: the nineteen pairs, from the tokens as the page resolved them. */
window.measureContrastPairs = (theme) => {
  document.documentElement.setAttribute('data-theme', theme);
  const measured = measureContrast(documentTokenReader());
  return {
    theme,
    all: measured.map((pair) => ({
      pair: `${pair.foreground} on ${pair.background}`,
      minimum: pair.minimum,
      ratio: Number(pair.ratio.toFixed(2)),
      passes: pair.passes,
    })),
    failures: measured.filter((pair) => !pair.passes).length,
  };
};

/**
 * U20: nothing may widen the page at the current viewport.
 *
 * A node inside an **own-box scroller** is not an offender: `.if-scroll-x`, the
 * tablist and the phase grid are wider than 360px on purpose and scroll inside
 * themselves, which is the one thing the panel allows. Listing them made the
 * result need a human to read past its own output — and a list that has to be
 * excused is not a measurement.
 */
window.measureHorizontalOverflow = () => {
  const root = document.documentElement;
  const offenders: string[] = [];

  const scrollsItself = (node: HTMLElement): boolean => {
    for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
      const overflowX = getComputedStyle(parent).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
    return false;
  };

  for (const node of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    const rect = node.getBoundingClientRect();
    if (rect.right > root.clientWidth + 1 && !scrollsItself(node)) {
      offenders.push(`${node.tagName.toLowerCase()}.${node.className}`.slice(0, 120));
    }
  }
  return {
    innerWidth: window.innerWidth,
    clientWidth: root.clientWidth,
    scrollWidth: root.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    horizontalScroll: root.scrollWidth > root.clientWidth,
    offenders: offenders.slice(0, 5),
  };
};

/** U6: "Estado agora" fits without scrolling, with the alerts card open. */
window.measureNowBlock = () => {
  const heading = Array.from(document.querySelectorAll('h2')).find(
    (node) => node.textContent?.trim() === 'Estado agora',
  );
  const block = heading?.closest('section');
  const alerts = Array.from(document.querySelectorAll('h2')).find(
    (node) => node.textContent?.trim() === 'Erros e avisos',
  );
  if (!block) return { found: false };
  const rect = block.getBoundingClientRect();
  return {
    found: true,
    alertsCardOpen: alerts !== undefined,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    bottom: Math.round(rect.bottom),
    innerHeight: window.innerHeight,
    fitsWithoutScrolling: rect.bottom <= window.innerHeight,
  };
};
