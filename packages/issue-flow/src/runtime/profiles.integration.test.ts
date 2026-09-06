import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRuntimeProfiles, type RuntimeProfile } from './profiles.js';
import { createTmuxGateway, type TmuxGateway } from './tmux/gateway.js';
import { ensureSessionLayout, planSessionLayout } from './tmux/layout.js';

/**
 * **C8** against a real tmux server: switching profile really does replace the
 * window's layout, and does it inside the §35 budget for `ensureSessionLayout`
 * (≤ 400 ms; the upstream measures 254 ms for the two-pane case).
 *
 * The colocated `profiles.characterization.test.ts` pins the *decisions* — which
 * tmux calls a switch makes and that the agent comes back on the same
 * conversation. This file answers the question a fake gateway cannot: after the
 * switch, does tmux itself report the new window?
 *
 * Everything runs on a throwaway socket, never `issue-flow`: a test that killed
 * windows on the real project socket would kill a real agent.
 */
const socketName = `issue-flow-test-${randomUUID().slice(0, 8)}`;

// Probed synchronously at module load: `it.runIf` is evaluated during
// collection, so a flag assigned in `beforeAll` would always still be false.
const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

const profiles = parseRuntimeProfiles(
  {
    default: {
      panes: [
        { id: 'agent', kind: 'agent', focus: true },
        { id: 'shell', kind: 'shell', split: 'right', sizePct: 25 },
      ],
    },
    wide: {
      panes: [
        { id: 'agent', kind: 'agent', focus: true },
        { id: 'shell', kind: 'shell', split: 'bottom', sizePct: 30 },
        { id: 'logs', kind: 'shell', split: 'right', sizePct: 40 },
      ],
    },
  },
  true,
);

function requireProfile(name: string): RuntimeProfile {
  const profile = profiles[name];
  if (profile === undefined) throw new Error(`fixture profile "${name}" is missing`);
  return profile;
}

async function killTestServer(): Promise<void> {
  await execa('tmux', ['-L', socketName, 'kill-server'], { reject: false });
}

describe('C8 against a real tmux server', () => {
  let tmux: TmuxGateway;
  let cwd: string;
  const dirs: string[] = [];

  afterAll(async () => {
    if (tmuxAvailable) await killTestServer();
  });

  beforeEach(async () => {
    tmux = createTmuxGateway({ socketName });
    cwd = await mkdtemp(join(tmpdir(), 'issue-flow-profiles-'));
    dirs.push(cwd);
  });

  afterEach(async () => {
    if (tmuxAvailable) await killTestServer();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function planFor(profile: RuntimeProfile, projectId = 'proj-a1b2c3') {
    return planSessionLayout({
      projectId,
      branch: 'feature',
      templates: profile.panes,
      context: {
        repoRoot: cwd,
        worktreePath: cwd,
        // `sleep` stands in for the agent: a pane whose command exits is closed
        // by tmux, and the pane count is exactly what the assertions read.
        paneCommands: { agent: 'sleep 600', shell: '/bin/sh' },
      },
    });
  }

  it.runIf(tmuxAvailable)('replaces the window when the profile changes', async () => {
    const first = await ensureSessionLayout(tmux, planFor(requireProfile('default')));
    expect(first.mode).toBe('fresh');
    await expect(tmux.countPanes(first.sessionName, first.windowName)).resolves.toBe(2);

    const switched = await ensureSessionLayout(tmux, planFor(requireProfile('wide')), {
      force: true,
    });

    expect(switched.mode).toBe('resume');
    // Same window, new layout: every target built from the window name — the
    // terminal attach included — survives the switch.
    expect(switched.windowName).toBe(first.windowName);
    await expect(tmux.countPanes(switched.sessionName, switched.windowName)).resolves.toBe(3);
  });

  it.runIf(tmuxAvailable)('leaves the window alone when the profile did not change', async () => {
    const first = await ensureSessionLayout(tmux, planFor(requireProfile('wide')));
    const paneId = await tmux.getPaneId(`${first.sessionName}:${first.windowName}.0`);

    const again = await ensureSessionLayout(tmux, planFor(requireProfile('wide')));

    expect(again.mode).toBe('reattach');
    // The same pane object, not a rebuilt one: the agent inside it never noticed.
    await expect(tmux.getPaneId(`${again.sessionName}:${again.windowName}.0`)).resolves.toBe(
      paneId,
    );
  });

  // §35: a profile switch is one `ensureSessionLayout`, so it answers to the
  // same 400 ms ceiling as the layout it rebuilds.
  it.runIf(tmuxAvailable)('switches profile within the 400 ms budget', async () => {
    const samples: number[] = [];
    await ensureSessionLayout(tmux, planFor(requireProfile('default')));

    for (let round = 0; round < 5; round += 1) {
      const target = round % 2 === 0 ? 'wide' : 'default';
      const startedAt = Date.now();
      await ensureSessionLayout(tmux, planFor(requireProfile(target)), { force: true });
      samples.push(Date.now() - startedAt);
    }

    const sorted = [...samples].sort((left, right) => left - right);
    const median = sorted[2] ?? Number.POSITIVE_INFINITY;
    console.log(`profile switch: median ${median} ms over ${samples.length}`);
    expect(median).toBeLessThanOrEqual(400);
  });
});
