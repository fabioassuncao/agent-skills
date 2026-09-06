import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebServerHandle } from '../web/server.js';

/**
 * What `serve` tells the person who typed it.
 *
 * `web serve` could afford to say nothing: it is spawned detached with
 * `stdio: 'ignore'`, so there is nobody to talk to. `serve` inherited that
 * silence when it became the canonical command (§47.4) and kept passing
 * `info: noop, warn: noop` into the bind — which made every outcome look
 * identical from a terminal. A foreground server that prints nothing cannot be
 * told apart from one that hung, and an invocation that exits 0 without a word
 * cannot be told apart from one that did nothing.
 *
 * These cases pin the three outcomes to output. They deliberately assert *that
 * something was said* rather than the exact wording, which is copy and moves.
 */

const bind = vi.hoisted(() => ({
  result: null as WebServerHandle | null,
  options: null as { info?: (m: string) => void; warn?: (m: string) => void } | null,
}));

vi.mock('../web/lock.js', () => ({
  ensureSingleWebServer: vi.fn(async (options: Record<string, unknown>) => {
    bind.options = options as { info?: (m: string) => void; warn?: (m: string) => void };
    return bind.result;
  }),
}));

const printed = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('../ui/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/logger.js')>();
  return {
    ...actual,
    printInfo: (message: string) => printed.lines.push(`info: ${message}`),
    printWarning: (message: string) => printed.lines.push(`warn: ${message}`),
    printError: (message: string) => printed.lines.push(`error: ${message}`),
  };
});

const { runServe } = await import('./serve.js');

describe('what serve reports', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-serve-report-'));
    printed.lines = [];
    bind.options = null;
    bind.result = null;
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function run() {
    // A real port: 0 is rejected by the web config schema, which would make
    // the run fall back to the defaults and the assertions describe those.
    return runServe({ cwd: home, env: { ISSUE_FLOW_HOME: home }, host: '127.0.0.1', port: 3939 });
  }

  function boundHandle(): WebServerHandle {
    return {
      server: { close: (cb?: () => void) => cb?.() } as unknown as WebServerHandle['server'],
      host: '127.0.0.1',
      port: 3737,
      url: 'http://localhost:3737',
      instanceId: 'test-instance',
      close: async () => {},
    };
  }

  // The regression itself: silencing the bind's own reporters is what made
  // every outcome indistinguishable, including the two warnings that say the
  // monitor is reachable from the network and the terminal is therefore off.
  it('never silences the reporters it hands to the bind', async () => {
    bind.result = boundHandle();
    await run();

    expect(bind.options).not.toBeNull();
    bind.options?.info?.('something worth knowing');
    bind.options?.warn?.('something worth worrying about');

    expect(printed.lines).toContain('info: something worth knowing');
    expect(printed.lines).toContain('warn: something worth worrying about');
  });

  // A foreground server that says nothing reads as a hung one — which is
  // exactly how this was reported.
  it('says it is staying in the foreground once it is serving', async () => {
    bind.result = boundHandle();
    const code = await run();

    expect(code).toBe(0);
    expect(printed.lines.join('\n')).toMatch(/foreground|Ctrl\+C/i);
  });

  // Exiting 0 without a word looks like a command that did nothing at all.
  it('explains itself when another instance already owns the lock', async () => {
    bind.result = { ...boundHandle(), server: undefined };
    const code = await run();

    expect(code).toBe(0);
    expect(printed.lines.length).toBeGreaterThan(0);
    expect(printed.lines.join('\n')).toMatch(/exiting/i);
  });

  it('names the address it could not take when the bind fails', async () => {
    bind.result = null;
    const code = await run();

    expect(code).toBe(1);
    expect(printed.lines.join('\n')).toMatch(/error:/);
    expect(printed.lines.join('\n')).toContain('127.0.0.1:3939');
  });
});
