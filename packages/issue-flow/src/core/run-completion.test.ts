import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveRunSignals,
  IDLE_GRACE_MS,
  type RunCompletionDeps,
  type RunCompletionTarget,
  resetRunCompletionState,
  runCompletionPass,
  settleRun,
} from './run-completion.js';

/**
 * Parity suite for the port of
 * `.references/webmux-main/backend/src/services/oneshot-watcher-service.ts`
 * @ d8c9d5f, whose own suite is
 * `backend/src/__tests__/oneshot-watcher-service.test.ts` (12 cases).
 *
 * Ten of the twelve are ported; the two that are not are the implicit
 * `postToLinear` ones. ADR-14 was later reversed for explicit UI/API posting
 * and headless pickup, not for a side effect at the end of every run. The mapping of the
 * upstream vocabulary onto this one is:
 *
 * | upstream | here |
 * |---|---|
 * | `meta.oneshot` present | no `human_hold` on the run — `isArmed` |
 * | `agentLifecycle` `stopped`/`error` | `lifecycle: 'stopped'` |
 * | `agentLifecycle` `closed` (never reported in) | `lifecycle: null` |
 * | `closeWorktree` | `closeRun` — the run's live agent sessions |
 * | `disarmOneshot` | `disarm` |
 */

function target(overrides: Partial<RunCompletionTarget> = {}): RunCompletionTarget {
  return {
    runId: 'run-1',
    issueId: '42',
    pipelineOutcome: null,
    lifecycle: 'running',
    hasPr: false,
    ...overrides,
  };
}

interface Recorded {
  deps: RunCompletionDeps;
  closed: string[];
  disarmed: string[];
}

function deps(overrides: Partial<RunCompletionDeps> = {}): Recorded {
  const closed: string[] = [];
  const disarmed: string[] = [];
  const built: RunCompletionDeps = {
    targets: [target()],
    isArmed: async () => true,
    closeRun: async (runId) => {
      closed.push(runId);
    },
    disarm: async (runId) => {
      disarmed.push(runId);
    },
    autoClose: true,
    now: () => 1_000,
    ...overrides,
  };
  return { deps: built, closed, disarmed };
}

describe('run completion', () => {
  beforeEach(() => {
    resetRunCompletionState();
  });

  afterEach(() => {
    resetRunCompletionState();
    vi.restoreAllMocks();
  });

  // Upstream: "skips worktrees that are not oneshot source". The guarantee is
  // the same — a pass never touches a run it was not handed.
  it('only settles the runs it was given', async () => {
    const recorded = deps({
      targets: [target({ runId: 'mine', pipelineOutcome: 'completed' })],
    });
    await runCompletionPass(recorded.deps);
    expect(recorded.closed).toEqual(['mine']);
    expect(recorded.disarmed).toEqual(['mine']);
  });

  // Upstream: "skips when meta is missing oneshot block (disarmed)".
  it('stands down when a person took the run over', async () => {
    const recorded = deps({
      targets: [target({ pipelineOutcome: 'completed' })],
      isArmed: async () => false,
    });
    expect(await runCompletionPass(recorded.deps)).toBe(0);
    expect(recorded.closed).toEqual([]);
    expect(recorded.disarmed).toEqual([]);
  });

  // Upstream: "does not fire while agent is still running".
  it('does not fire while the agent is still working', async () => {
    const recorded = deps({ targets: [target({ lifecycle: 'running' })] });
    expect(await runCompletionPass(recorded.deps)).toBe(0);
    expect(recorded.closed).toEqual([]);
  });

  // Upstream: "waits the idle grace before firing on idle".
  it('waits out the grace before firing on idle', async () => {
    let clock = 1_000;
    const recorded = deps({
      targets: [target({ lifecycle: 'idle' })],
      now: () => clock,
    });

    expect(await runCompletionPass(recorded.deps)).toBe(0);
    expect(recorded.closed).toEqual([]);

    clock += IDLE_GRACE_MS - 1;
    expect(await runCompletionPass(recorded.deps)).toBe(0);
    expect(recorded.closed).toEqual([]);

    clock += 1;
    expect(await runCompletionPass(recorded.deps)).toBe(1);
    expect(recorded.closed).toEqual(['run-1']);
  });

  // Upstream: "fires immediately on stopped without waiting for grace".
  it('fires immediately when the agent reports it stopped', async () => {
    const recorded = deps({ targets: [target({ lifecycle: 'stopped' })] });
    expect(await runCompletionPass(recorded.deps)).toBe(1);
    expect(recorded.closed).toEqual(['run-1']);
    expect(recorded.disarmed).toEqual(['run-1']);
  });

  /**
   * The Issue Flow half of §17's convergence, and the reason the agent's own
   * signals stay *additional*: the pipeline's verdict is terminal on its own,
   * with no grace and regardless of what the agent last said.
   */
  it("fires immediately on the pipeline's own verdict, whatever the agent said", async () => {
    const recorded = deps({
      targets: [target({ pipelineOutcome: 'completed', lifecycle: 'running' })],
    });
    expect(await runCompletionPass(recorded.deps)).toBe(1);
    expect(recorded.closed).toEqual(['run-1']);
  });

  // Upstream: "respects autoCloseOnDone=false but still posts to Linear".
  it('respects autoClose=false and still stands the run down', async () => {
    const recorded = deps({
      targets: [target({ pipelineOutcome: 'completed' })],
      autoClose: false,
    });
    expect(await runCompletionPass(recorded.deps)).toBe(1);
    expect(recorded.closed).toEqual([]);
    expect(recorded.disarmed).toEqual(['run-1']);
  });

  // Upstream: "bails on close + disarm when meta is disarmed during
  // postToLinear". The window is different — here it is the run's own
  // finalization — but the race, and the rule, are identical.
  it('aborts the close when a person takes over between the decision and the close', async () => {
    let reads = 0;
    const recorded = deps({
      targets: [target({ pipelineOutcome: 'completed' })],
      isArmed: async () => {
        reads += 1;
        return reads === 1;
      },
    });
    expect(await runCompletionPass(recorded.deps)).toBe(0);
    expect(recorded.closed).toEqual([]);
    expect(recorded.disarmed).toEqual([]);
    expect(reads).toBe(2);
  });

  // Upstream: "still disarms when closeWorktree throws".
  it('still stands the run down when the close throws', async () => {
    const recorded = deps({
      targets: [target({ pipelineOutcome: 'completed' })],
      closeRun: async () => {
        throw new Error('tmux is gone');
      },
    });
    expect(await runCompletionPass(recorded.deps)).toBe(1);
    expect(recorded.disarmed).toEqual(['run-1']);
  });

  // Upstream: "does not immediately fire on a freshly upserted closed worktree
  // (cold-start guard)". `null` is this port's `closed`: no hook has reported
  // in, which is also what every run looks like in its first seconds.
  it('does not fire on a run whose agent has not reported in yet', async () => {
    const recorded = deps({ targets: [target({ lifecycle: null })] });
    expect(await runCompletionPass(recorded.deps)).toBe(0);
    expect(recorded.closed).toEqual([]);
  });

  // Upstream: "fires on `closed` once the idle grace has elapsed".
  it('fires on a silent run once the grace has elapsed', async () => {
    let clock = 1_000;
    const recorded = deps({ targets: [target({ lifecycle: null })], now: () => clock });
    expect(await runCompletionPass(recorded.deps)).toBe(0);
    clock += IDLE_GRACE_MS;
    expect(await runCompletionPass(recorded.deps)).toBe(1);
    expect(recorded.closed).toEqual(['run-1']);
  });

  /** The upstream `inFlight` guard: a slow close must not be started twice. */
  it('never settles the same run twice concurrently', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recorded = deps({
      targets: [target({ pipelineOutcome: 'completed' })],
      closeRun: async () => {
        await gate;
      },
    });
    const first = settleRun(recorded.deps.targets[0] as RunCompletionTarget, recorded.deps);
    const second = await settleRun(recorded.deps.targets[0] as RunCompletionTarget, recorded.deps);
    expect(second).toBe(false);
    release?.();
    expect(await first).toBe(true);
    expect(recorded.disarmed).toEqual(['run-1']);
  });

  /** The idle clock resets: an agent that goes back to work starts over. */
  it('resets the grace when the agent goes back to work', async () => {
    let clock = 1_000;
    let current = target({ lifecycle: 'idle' });
    const recorded = deps({
      targets: [],
      now: () => clock,
    });
    expect(await settleRun(current, recorded.deps)).toBe(false);

    clock += IDLE_GRACE_MS - 1;
    current = target({ lifecycle: 'running' });
    expect(await settleRun(current, recorded.deps)).toBe(false);

    clock += 2;
    current = target({ lifecycle: 'idle' });
    expect(await settleRun(current, recorded.deps)).toBe(false);
    expect(recorded.closed).toEqual([]);
  });
});

describe('deriveRunSignals', () => {
  it('reads the last reported lifecycle', () => {
    expect(
      deriveRunSignals([
        { type: 'agent_status_changed', lifecycle: 'running' },
        { type: 'agent_status_changed', lifecycle: 'idle' },
      ]),
    ).toEqual({ lifecycle: 'idle', hasPr: false });
  });

  it('treats an explicit agent_stopped as terminal', () => {
    expect(
      deriveRunSignals([
        { type: 'agent_status_changed', lifecycle: 'running' },
        { type: 'agent_stopped', lifecycle: null },
      ]),
    ).toEqual({ lifecycle: 'stopped', hasPr: false });
  });

  it('remembers that a Pull Request was opened', () => {
    expect(deriveRunSignals([{ type: 'pr_opened', lifecycle: null }])).toEqual({
      lifecycle: null,
      hasPr: true,
    });
  });

  it('ignores a lifecycle this release does not know', () => {
    expect(deriveRunSignals([{ type: 'agent_status_changed', lifecycle: 'dancing' }])).toEqual({
      lifecycle: null,
      hasPr: false,
    });
  });

  it('reports nothing for a run whose agent never reported in', () => {
    expect(deriveRunSignals([])).toEqual({ lifecycle: null, hasPr: false });
  });
});
