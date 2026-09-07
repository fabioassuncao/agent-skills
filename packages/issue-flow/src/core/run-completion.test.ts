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

  it('only settles the runs it was given', async () => {
    const recorded = deps({
      targets: [target({ runId: 'mine', pipelineOutcome: 'completed' })],
    });
    await runCompletionPass(recorded.deps);
    expect(recorded.closed).toEqual(['mine']);
    expect(recorded.disarmed).toEqual(['mine']);
  });

  it('stands down when a person took the run over', async () => {
    const recorded = deps({
      targets: [target({ pipelineOutcome: 'completed' })],
      isArmed: async () => false,
    });
    expect(await runCompletionPass(recorded.deps)).toBe(0);
    expect(recorded.closed).toEqual([]);
    expect(recorded.disarmed).toEqual([]);
  });

  it('does not fire while the agent is still working', async () => {
    const recorded = deps({ targets: [target({ lifecycle: 'running' })] });
    expect(await runCompletionPass(recorded.deps)).toBe(0);
    expect(recorded.closed).toEqual([]);
  });

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

  it('fires immediately when the agent reports it stopped', async () => {
    const recorded = deps({ targets: [target({ lifecycle: 'stopped' })] });
    expect(await runCompletionPass(recorded.deps)).toBe(1);
    expect(recorded.closed).toEqual(['run-1']);
    expect(recorded.disarmed).toEqual(['run-1']);
  });

  it("fires immediately on the pipeline's own verdict, whatever the agent said", async () => {
    const recorded = deps({
      targets: [target({ pipelineOutcome: 'completed', lifecycle: 'running' })],
    });
    expect(await runCompletionPass(recorded.deps)).toBe(1);
    expect(recorded.closed).toEqual(['run-1']);
  });

  it('respects autoClose=false and still stands the run down', async () => {
    const recorded = deps({
      targets: [target({ pipelineOutcome: 'completed' })],
      autoClose: false,
    });
    expect(await runCompletionPass(recorded.deps)).toBe(1);
    expect(recorded.closed).toEqual([]);
    expect(recorded.disarmed).toEqual(['run-1']);
  });

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

  it('does not fire on a run whose agent has not reported in yet', async () => {
    const recorded = deps({ targets: [target({ lifecycle: null })] });
    expect(await runCompletionPass(recorded.deps)).toBe(0);
    expect(recorded.closed).toEqual([]);
  });

  it('fires on a silent run once the grace has elapsed', async () => {
    let clock = 1_000;
    const recorded = deps({ targets: [target({ lifecycle: null })], now: () => clock });
    expect(await runCompletionPass(recorded.deps)).toBe(0);
    clock += IDLE_GRACE_MS;
    expect(await runCompletionPass(recorded.deps)).toBe(1);
    expect(recorded.closed).toEqual(['run-1']);
  });

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
