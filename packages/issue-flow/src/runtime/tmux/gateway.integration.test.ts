import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTmuxGateway, type TmuxGateway } from './gateway.js';
import { ensureSessionLayout, type PaneTemplate, planSessionLayout } from './layout.js';

/**
 * The tmux gateway against a real tmux server.
 *
 * Covers phase 6's completion criterion — **C3**, plus the §35 budget for
 * `ensureSessionLayout` with two panes (**≤ 400 ms**, upstream 254 ms) — and the
 * one behaviour the port is not allowed to lose: a missing tmux degrades
 * cleanly instead of failing a run.
 *
 * Every command runs on a **throwaway socket**, never `issue-flow` and never the
 * user's default: a test that killed windows on the real project socket would
 * kill a real agent.
 */
const socketName = `issue-flow-test-${randomUUID().slice(0, 8)}`;

// Probed at module load, synchronously: `it.runIf` is evaluated while the file
// is being collected, so an availability flag assigned in `beforeAll` would
// always still be false and every case would skip silently.
const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

async function killTestServer(): Promise<void> {
  await execa('tmux', ['-L', socketName, 'kill-server'], { reject: false });
}

describe('tmux gateway against a real server', () => {
  let tmux: TmuxGateway;
  let cwd: string;
  const dirs: string[] = [];

  afterAll(async () => {
    if (tmuxAvailable) await killTestServer();
  });

  beforeEach(async () => {
    tmux = createTmuxGateway({ socketName });
    cwd = await mkdtemp(join(tmpdir(), 'issue-flow-tmux-'));
    dirs.push(cwd);
  });

  afterEach(async () => {
    if (tmuxAvailable) await killTestServer();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function plan(templates: PaneTemplate[], projectId = 'proj-a1b2c3') {
    return planSessionLayout({
      projectId,
      branch: 'feature',
      templates,
      context: {
        repoRoot: cwd,
        worktreePath: cwd,
        // `true` exits immediately, which is what makes the "a pane died"
        // case reproducible below.
        paneCommands: { agent: 'sleep 30', shell: '/bin/sh' },
      },
    });
  }

  it.runIf(tmuxAvailable)('reports tmux as available', async () => {
    await expect(tmux.isAvailable()).resolves.toBe(true);
  });

  // C3: the window exists, is named after the branch, has the planned panes and
  // carries the options that keep its name stable.
  it.runIf(tmuxAvailable)('C3: lays out a worktree window with its panes and options', async () => {
    const layout = plan([
      { id: 'agent', kind: 'agent', focus: true },
      { id: 'shell', kind: 'shell' },
    ]);
    const result = await ensureSessionLayout(tmux, layout);

    expect(result.mode).toBe('fresh');
    expect(result.sessionName).toBe('if-proj-a1b2c3');
    expect(result.windowName).toBe('if-feature');
    await expect(tmux.hasWindow(layout.sessionName, layout.windowName)).resolves.toBe(true);
    await expect(tmux.countPanes(layout.sessionName, layout.windowName)).resolves.toBe(2);

    const windows = await tmux.listWindows();
    expect(windows).toContainEqual({
      sessionName: 'if-proj-a1b2c3',
      windowName: 'if-feature',
      paneCount: 2,
    });

    // The pane id resolves, which is what the terminal transport will attach to.
    await expect(tmux.getPaneId(`${layout.sessionName}:${layout.windowName}.0`)).resolves.toMatch(
      /^%\d+$/,
    );
  });

  // The improvement over the upstream (§27): reopening must not kill the agent.
  it.runIf(tmuxAvailable)('reattaches to an intact window, leaving its panes alive', async () => {
    const layout = plan([
      { id: 'agent', kind: 'agent', focus: true },
      { id: 'shell', kind: 'shell' },
    ]);
    await ensureSessionLayout(tmux, layout);
    const firstPaneId = await tmux.getPaneId(`${layout.sessionName}:${layout.windowName}.0`);

    const second = await ensureSessionLayout(tmux, layout);

    expect(second.mode).toBe('reattach');
    // Same pane id: nothing was recreated, so nothing running inside it died.
    await expect(tmux.getPaneId(`${layout.sessionName}:${layout.windowName}.0`)).resolves.toBe(
      firstPaneId,
    );
  });

  it.runIf(tmuxAvailable)(
    'keeps stable owner pane ids when a grouped viewer shares the same socket',
    async () => {
      const layout = plan([{ id: 'agent', kind: 'agent', focus: true }]);
      await ensureSessionLayout(tmux, layout);
      const ownerPane = await tmux.getPaneId(`${layout.sessionName}:${layout.windowName}.0`);
      const parkingWindow = 'ifp-feature-a1b2c3d4e5f6';
      const forkPane = await tmux.createParkedPane?.({
        sessionName: layout.sessionName,
        parkingWindow,
        cwd,
        command: 'sleep 30',
      });
      expect(forkPane).toMatch(/^%\d+$/);
      await tmux.tagPaneOwner?.(ownerPane, 'owner-token', layout.sessionName);
      await tmux.tagPaneOwner?.(forkPane as string, 'fork-token', layout.sessionName);

      const viewer = `if-view-${randomUUID().slice(0, 8)}`;
      await execa('tmux', [
        '-L',
        socketName,
        'new-session',
        '-d',
        '-s',
        viewer,
        '-t',
        layout.sessionName,
      ]);

      // Aggregated ownership must ignore linked viewer aliases. Otherwise the
      // last duplicate would make reconciliation believe an owner pane moved.
      const locations = await tmux.listPaneLocations?.();
      expect(locations?.filter((entry) => entry.paneId === ownerPane)).toEqual([
        {
          paneId: ownerPane,
          sessionName: layout.sessionName,
          windowName: layout.windowName,
          ownerToken: 'owner-token',
        },
      ]);
      expect(locations?.filter((entry) => entry.paneId === forkPane)).toEqual([
        {
          paneId: forkPane,
          sessionName: layout.sessionName,
          windowName: parkingWindow,
          ownerToken: 'fork-token',
        },
      ]);
      await expect(tmux.getPaneIdentity?.(forkPane as string)).resolves.toEqual({
        paneId: forkPane,
        sessionName: layout.sessionName,
        windowName: parkingWindow,
        ownerToken: 'fork-token',
      });

      await tmux.swapPanes?.(forkPane as string, ownerPane);
      await expect(tmux.hasPaneStrict?.(ownerPane)).resolves.toBe(true);
      await expect(tmux.hasPaneStrict?.(forkPane as string)).resolves.toBe(true);
      await expect(tmux.getPaneWindow?.(forkPane as string)).resolves.toBe(layout.windowName);
      await expect(tmux.getPaneWindow?.(ownerPane)).resolves.toBe(parkingWindow);
    },
  );

  it.runIf(tmuxAvailable)('rebuilds the window when forced, giving it new panes', async () => {
    const layout = plan([{ id: 'agent', kind: 'agent' }]);
    await ensureSessionLayout(tmux, layout);
    const firstPaneId = await tmux.getPaneId(`${layout.sessionName}:${layout.windowName}.0`);

    const second = await ensureSessionLayout(tmux, layout, { force: true });

    expect(second.mode).toBe('resume');
    await expect(tmux.getPaneId(`${layout.sessionName}:${layout.windowName}.0`)).resolves.not.toBe(
      firstPaneId,
    );
  });

  it.runIf(tmuxAvailable)('keeps the session alive with no client attached', async () => {
    // `destroy-unattached off` is what lets an agent keep working with the
    // browser closed; without it the session would already be gone here.
    const layout = plan([{ id: 'agent', kind: 'agent' }]);
    await ensureSessionLayout(tmux, layout);
    const option = await execa(
      'tmux',
      ['-L', socketName, 'show-options', '-t', layout.sessionName, 'destroy-unattached'],
      { reject: false },
    );
    expect(option.stdout).toContain('off');
  });

  it.runIf(tmuxAvailable)('kills a window and tolerates killing it twice', async () => {
    const layout = plan([{ id: 'agent', kind: 'agent' }]);
    await ensureSessionLayout(tmux, layout);

    await tmux.killWindow(layout.sessionName, layout.windowName);
    await expect(tmux.hasWindow(layout.sessionName, layout.windowName)).resolves.toBe(false);
    // Already gone is not a failure: teardown runs on paths that may have
    // raced with a server exit.
    await expect(tmux.killWindow(layout.sessionName, layout.windowName)).resolves.toBeUndefined();
  });

  it.runIf(tmuxAvailable)('strictly kills a window and confirms it is absent', async () => {
    const layout = plan([{ id: 'agent', kind: 'agent' }]);
    await ensureSessionLayout(tmux, layout);

    expect(tmux.killWindowStrict).toBeDefined();
    await expect(
      tmux.killWindowStrict?.(layout.sessionName, layout.windowName),
    ).resolves.toBeUndefined();
    await expect(tmux.hasWindow(layout.sessionName, layout.windowName)).resolves.toBe(false);
    // An already absent session is a proved absence, not an error.
    await expect(
      tmux.killWindowStrict?.(layout.sessionName, layout.windowName),
    ).resolves.toBeUndefined();
  });

  // ADR-13: reconciliation asks once for everything, never once per entity.
  it.runIf(tmuxAvailable)('lists every window of every session in one call', async () => {
    await ensureSessionLayout(tmux, plan([{ id: 'agent', kind: 'agent' }], 'proj-one'));
    await ensureSessionLayout(tmux, plan([{ id: 'agent', kind: 'agent' }], 'proj-two'));

    // `new-session -d` always creates a window of its own, and a session with
    // no windows is destroyed by tmux — so every session carries one unnamed
    // window besides the worktree's. The upstream lives with the same thing;
    // what matters is that one aggregated call sees both projects.
    const windows = await tmux.listWindows();
    expect(
      windows
        .filter((entry) => entry.windowName === 'if-feature')
        .map((entry) => entry.sessionName)
        .sort(),
    ).toEqual(['if-proj-one', 'if-proj-two']);
  });

  // Without a server there are no windows, which is an ordinary answer and the
  // one reconciliation needs — not an error.
  it.runIf(tmuxAvailable)('answers with no windows when no server is running', async () => {
    await killTestServer();
    await expect(tmux.listWindows()).resolves.toEqual([]);
  });

  // ADR-03: a machine with no tmux keeps working. `isAvailable` is the check a
  // caller makes before choosing the interactive mode at all.
  it('degrades cleanly when tmux is not installed', async () => {
    const missing = createTmuxGateway({
      socketName,
      env: { ...process.env, PATH: '/nonexistent' },
    });
    await expect(missing.isAvailable()).resolves.toBe(false);
    await expect(missing.listWindows()).resolves.toEqual([]);
  });

  // §35: ensureSessionLayout with two panes, measured at 254 ms upstream.
  it.runIf(tmuxAvailable)('lays out two panes within the 400 ms budget', async () => {
    const samples: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const layout = plan(
        [
          { id: 'agent', kind: 'agent', focus: true },
          { id: 'shell', kind: 'shell' },
        ],
        `proj-bench-${round}`,
      );
      const startedAt = Date.now();
      await ensureSessionLayout(tmux, layout);
      samples.push(Date.now() - startedAt);
    }

    const sorted = [...samples].sort((left, right) => left - right);
    const median = sorted[2] ?? Number.POSITIVE_INFINITY;
    console.log(`ensureSessionLayout (2 panes): median ${median} ms over ${samples.length}`);
    expect(median).toBeLessThanOrEqual(400);
  });

  // §35: the marginal cost of one more session, measured at 15 ms upstream.
  it.runIf(tmuxAvailable)('adds a session for under the 30 ms marginal budget', async () => {
    const templates: PaneTemplate[] = [{ id: 'agent', kind: 'agent' }];
    await ensureSessionLayout(tmux, plan(templates, 'proj-warm'));

    const samples: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const layout = plan(templates, `proj-marginal-${round}`);
      const startedAt = Date.now();
      await tmux.ensureSession(layout.sessionName, cwd);
      samples.push(Date.now() - startedAt);
    }

    const sorted = [...samples].sort((left, right) => left - right);
    const median = sorted[2] ?? Number.POSITIVE_INFINITY;
    console.log(`marginal session cost: median ${median} ms over ${samples.length}`);
    expect(median).toBeLessThanOrEqual(30);
  });

  // ADR-13 again, as a measurement: reconciliation has to stay O(1) in N. Only
  // sessions are created here — the cost being measured is one aggregated
  // `list-windows -a`, not the layout work.
  it.runIf(tmuxAvailable)(
    'lists windows in constant time as sessions grow',
    async () => {
      async function measureListWindows(): Promise<number> {
        const samples: number[] = [];
        for (let round = 0; round < 5; round += 1) {
          const startedAt = Date.now();
          await tmux.listWindows();
          samples.push(Date.now() - startedAt);
        }
        return [...samples].sort((left, right) => left - right)[2] ?? Number.POSITIVE_INFINITY;
      }

      await tmux.ensureServer();
      await tmux.ensureSession('if-proj-0', cwd);
      const withOne = await measureListWindows();

      for (let index = 1; index <= 20; index += 1) {
        await tmux.ensureSession(`if-proj-${index}`, cwd);
      }
      const withTwentyOne = await measureListWindows();

      console.log(`list-windows -a: ${withOne} ms at N=1, ${withTwentyOne} ms at N=21`);
      expect((await tmux.listWindows()).length).toBe(21);
      // Constant, not proportional: the budget is a ceiling and the growth from
      // 1 to 21 sessions must not consume it.
      expect(withTwentyOne).toBeLessThanOrEqual(50);
    },
    20_000,
  );
});
