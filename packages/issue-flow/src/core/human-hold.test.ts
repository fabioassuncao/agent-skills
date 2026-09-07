import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PlanRepositoryContext,
  resetPlanRepositories,
  saveSessionEvent,
} from '../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { installHumanHoldGate, isCurrentRunHeld } from './hold-gate.js';
import {
  currentHumanHold,
  heldForMs,
  holdForHuman,
  isHeldForHuman,
  releaseHumanHold,
  resetHumanHoldCache,
  startHumanHoldWatch,
} from './human-hold.js';
import { createInitialSnapshot } from './session-state.js';
import { createWatchdog } from './watchdog.js';

/**
 * **C10** of §34, and the rule §32 states as non-negotiable:
 *
 * > While a run is held, the watchdog does not kill the process and the
 * > pipeline does not advance a phase.
 *
 * The mechanism itself is absorbed from WebMux's `disarmOneshotIfArmed`: a
 * human touching the keyboard is the signal, with no confirmation and no mode
 * to switch.
 */
describe('human hold', () => {
  let home: string;
  let context: PlanRepositoryContext;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-hold-'));
    context = {
      tasksPath: join(home, 'projects', 'proj', 'issues', '1', 'tasks.json'),
      projectId: 'proj',
      issueId: '1',
      projectRoot: '/repo',
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
    resetHumanHoldCache();
    installHumanHoldGate(null);
    // A run row has to exist for a hold to attach to; the session publisher's
    // own write is what creates one.
    await saveSessionEvent(context, {
      sessionId: 'run-1',
      sequence: 1,
      event: {
        type: 'session:start',
        at: '2026-09-06T10:00:00.000Z',
        sessionId: 'run-1',
        issueNumber: 1,
        phases: ['execute'],
      },
      snapshot: { ...createInitialSnapshot(), sessionId: 'run-1', status: 'running' },
    });
  });

  afterEach(async () => {
    resetHumanHoldCache();
    installHumanHoldGate(null);
    resetPlanRepositories();
    await rm(home, { recursive: true, force: true });
  });

  it('records a takeover and reads it back', async () => {
    const hold = await holdForHuman(context, {
      runId: 'run-1',
      reason: 'takeover',
      now: () => new Date('2026-09-06T10:05:00.000Z'),
    });

    expect(hold).toEqual({
      runId: 'run-1',
      since: '2026-09-06T10:05:00.000Z',
      reason: 'takeover',
    });
    resetHumanHoldCache();
    await expect(currentHumanHold(context, 'run-1')).resolves.toEqual(hold);
    await expect(isHeldForHuman(context, 'run-1')).resolves.toBe(true);
  });

  // A person typing produces one of these per keystroke burst, and moving the
  // timestamp would erase how long they have been in control — which is exactly
  // what an escalation reads.
  it('is idempotent: a second takeover does not move the timestamp', async () => {
    const first = await holdForHuman(context, {
      runId: 'run-1',
      reason: 'takeover',
      now: () => new Date('2026-09-06T10:05:00.000Z'),
    });
    const second = await holdForHuman(context, {
      runId: 'run-1',
      reason: 'requested',
      now: () => new Date('2026-09-06T10:09:00.000Z'),
    });
    expect(second).toEqual(first);
  });

  it('releases only when asked, explicitly', async () => {
    await holdForHuman(context, { runId: 'run-1', reason: 'takeover' });
    await releaseHumanHold(context, 'run-1');

    resetHumanHoldCache();
    await expect(currentHumanHold(context, 'run-1')).resolves.toBeNull();
    await expect(isHeldForHuman(context, 'run-1')).resolves.toBe(false);
  });

  it('reports no hold for a run nobody ever took over', async () => {
    await expect(currentHumanHold(context, 'run-1')).resolves.toBeNull();
    await expect(currentHumanHold(context, 'does-not-exist')).resolves.toBeNull();
  });

  it('measures how long the person has been in control', () => {
    const now = () => new Date('2026-09-06T10:10:00.000Z');
    expect(
      heldForMs({ runId: 'r', since: '2026-09-06T10:00:00.000Z', reason: 'takeover' }, now),
    ).toBe(600_000);
    expect(heldForMs(null, now)).toBeNull();
    expect(heldForMs({ runId: 'r', since: 'not a date', reason: 'takeover' }, now)).toBeNull();
  });

  describe('the gate the watchdog reads', () => {
    it('answers false until a run installs one', () => {
      expect(isCurrentRunHeld()).toBe(false);
    });

    // A gate that throws must not freeze a run, and must not kill one either.
    it('answers false when the gate itself fails', () => {
      installHumanHoldGate(() => {
        throw new Error('storage exploded');
      });
      expect(isCurrentRunHeld()).toBe(false);
    });

    it('follows the run while the watch is installed, and stops with it', async () => {
      const watch = startHumanHoldWatch(context, 'run-1', 10);
      try {
        expect(isCurrentRunHeld()).toBe(false);

        await holdForHuman(context, { runId: 'run-1', reason: 'takeover' });
        await vi.waitFor(() => expect(isCurrentRunHeld()).toBe(true), { timeout: 2000 });

        await releaseHumanHold(context, 'run-1');
        await vi.waitFor(() => expect(isCurrentRunHeld()).toBe(false), { timeout: 2000 });
      } finally {
        watch.stop();
      }
      expect(isCurrentRunHeld()).toBe(false);
    });
  });

  // C10 — the rule that makes the whole feature safe. Without it the watchdog
  // kills the session at exactly the moment the human is thinking.
  describe('C10: the watchdog under a hold', () => {
    function fakeTimers() {
      const handlers: Array<() => void> = [];
      return {
        handlers,
        setInterval: (handler: () => void) => {
          handlers.push(handler);
          return 0 as unknown as NodeJS.Timeout;
        },
        clearInterval: () => {},
        tick: () => {
          for (const handler of [...handlers]) handler();
        },
      };
    }

    it('never declares a stall while a person holds the run', () => {
      const timers = fakeTimers();
      let now = 0;
      let held = true;
      const killed: string[] = [];

      const watchdog = createWatchdog({
        inactivityTimeoutMs: 1000,
        clock: () => now,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        isHeldByHuman: () => held,
        child: { kill: (signal) => killed.push(signal), done: Promise.resolve() },
      });

      // Ten times the silence budget, in complete silence.
      for (let step = 0; step < 10; step += 1) {
        now += 1000;
        timers.tick();
      }
      expect(watchdog.stalled).toBe(false);
      expect(killed).toEqual([]);

      // Releasing gives the agent the **full** budget again rather than killing
      // it for the minutes the person spent reading.
      held = false;
      now += 900;
      timers.tick();
      expect(watchdog.stalled).toBe(false);

      now += 200;
      timers.tick();
      expect(watchdog.stalled).toBe(true);
      expect(killed).toEqual(['SIGTERM']);
      watchdog.stop();
    });

    // The behaviour every release before human takeover had.
    it('still kills a genuinely stalled agent when nobody is holding it', () => {
      const timers = fakeTimers();
      let now = 0;
      const killed: string[] = [];

      const watchdog = createWatchdog({
        inactivityTimeoutMs: 1000,
        clock: () => now,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        child: { kill: (signal) => killed.push(signal), done: Promise.resolve() },
      });

      now += 1500;
      timers.tick();
      expect(watchdog.stalled).toBe(true);
      expect(killed).toEqual(['SIGTERM']);
      watchdog.stop();
    });

    it('reads the process-wide gate when the caller passes none', () => {
      const timers = fakeTimers();
      let now = 0;
      installHumanHoldGate(() => true);

      const watchdog = createWatchdog({
        inactivityTimeoutMs: 1000,
        clock: () => now,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
      });

      now += 5000;
      timers.tick();
      expect(watchdog.stalled).toBe(false);
      watchdog.stop();
    });
  });
});
