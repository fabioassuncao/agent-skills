import { describe, expect, it } from 'vitest';
import { executionsFor, getStoryById, normalizeStory, readSnapshot } from './snapshot';

/**
 * **U18** — a `session.json` from an older release renders, and nothing becomes
 * `NaN`.
 *
 * This is the known trap `web/AGENTS.md` names: `undefined` (the release that
 * wrote the file did not have the field) is not `null` (present, not reported)
 * is not `0` (a value). The first two mean "not reported" and neither may reach
 * the screen as `0` or `NaN`.
 *
 * **U21** lives here too: a verification verdict the panel does not recognise is
 * not silently upgraded to a pass.
 */

/** The oldest shape the panel still has to render: an all-but-empty object. */
const ANCIENT = { sessionId: 'run-1' };

describe('readSnapshot — backwards compatibility (U18)', () => {
  it('renders a snapshot with nothing in it, and produces no NaN', () => {
    const snapshot = readSnapshot(ANCIENT);

    expect(snapshot.sessionId).toBe('run-1');
    expect(snapshot.status).toBe('idle');
    expect(snapshot.issue.number).toBeNull();
    expect(snapshot.issue.labels).toEqual([]);
    expect(snapshot.phases).toEqual([]);
    expect(snapshot.stories).toEqual([]);
    expect(snapshot.elapsedSeconds).toBeNull();
    expect(snapshot.metrics.totalCostUsd).toBeNull();
    expect(snapshot.configuration).toBeNull();
    expect(snapshot.environment).toBeNull();
    expect(snapshot.verification).toBeNull();

    // Nothing anywhere in the projection is NaN.
    expect(JSON.stringify(snapshot)).not.toContain('null,"NaN"');
    const numbers: number[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'number') numbers.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(snapshot);
    expect(numbers.every((value) => Number.isFinite(value))).toBe(true);
  });

  it('keeps a reported zero and drops a non-number', () => {
    const snapshot = readSnapshot({
      elapsedSeconds: 0,
      progress: { percent: 0, phasesCompleted: 0, phasesTotal: '3' },
    });
    expect(snapshot.elapsedSeconds).toBe(0);
    expect(snapshot.progress.percent).toBe(0);
    expect(snapshot.progress.phasesCompleted).toBe(0);
    expect(snapshot.progress.phasesTotal).toBeNull();
  });

  it('clamps the one number that has a floor into range', () => {
    expect(readSnapshot({ progress: { percent: 140 } }).progress.percent).toBe(100);
    expect(readSnapshot({ progress: { percent: -5 } }).progress.percent).toBe(0);
    expect(readSnapshot({}).progress.percent).toBe(0);
  });

  it('falls back inside the closed vocabulary for an unknown status', () => {
    expect(readSnapshot({ status: 'something-new' }).status).toBe('idle');
  });

  it('derives errors and warnings when an old file has only logs', () => {
    const snapshot = readSnapshot({
      logs: [
        { at: 'x', level: 'error', message: 'boom' },
        { at: 'y', level: 'warn', message: 'careful' },
        { at: 'z', level: 'info', message: 'fine' },
      ],
    });
    expect(snapshot.errors.map((entry) => entry.message)).toEqual(['boom']);
    expect(snapshot.warnings.map((entry) => entry.message)).toEqual(['careful']);
  });

  it('reads the §32 escalation, and reports its absence as absence', () => {
    expect(readSnapshot({}).agent.awaitingInputEscalatedAt).toBeNull();
    expect(readSnapshot({}).agent.awaitingInputWaitedMs).toBeNull();

    const escalated = readSnapshot({
      agent: {
        lifecycle: 'awaiting-input',
        since: '2026-09-06T10:00:00.000Z',
        phase: 'execute',
        awaitingInputCount: 1,
        awaitingInputEscalatedAt: '2026-09-06T10:05:00.000Z',
        awaitingInputWaitedMs: 300_000,
        humanHold: null,
      },
    });
    expect(escalated.agent.awaitingInputEscalatedAt).toBe('2026-09-06T10:05:00.000Z');
    expect(escalated.agent.awaitingInputWaitedMs).toBe(300_000);
  });
});

describe('normalizeStory', () => {
  it('fills in every field an older plan could be missing', () => {
    const story = normalizeStory({ id: 'US-1', title: 'T' });
    expect(story.status).toBe('backlog');
    expect(story.stage).toBe('pending');
    expect(story.dependencies).toEqual([]);
    expect(story.acceptanceCriteria).toEqual([]);
    expect(story.description).toBe('');
    expect(story.history).toEqual([]);
    expect(story.passes).toBe(false);
    expect(story.durationSeconds).toBeNull();
  });

  it('never lets an unknown status or stage reach a badge', () => {
    const story = normalizeStory({ id: 'US-1', status: 'weird', stage: 'weirder' });
    expect(story.status).toBe('backlog');
    expect(story.stage).toBe('pending');
  });
});

describe('verification (U21)', () => {
  it('keeps unverified as a verdict of its own', () => {
    const snapshot = readSnapshot({
      verification: { verdict: 'unverified', level: 'contract', independence: 'independent' },
    });
    expect(snapshot.verification?.verdict).toBe('unverified');
  });

  it('never turns an unrecognised verdict into a pass', () => {
    const snapshot = readSnapshot({
      verification: { verdict: 'probably-fine', level: null, independence: null },
    });
    expect(snapshot.verification).not.toBeNull();
    expect(snapshot.verification?.verdict).toBeNull();
    expect(snapshot.verification?.verdict).not.toBe('passed');
  });

  it('distinguishes "no contract ran" from "a contract could not conclude"', () => {
    expect(readSnapshot({}).verification).toBeNull();
    expect(readSnapshot({ verification: null }).verification).toBeNull();
    expect(readSnapshot({ verification: { verdict: 'unverified' } })?.verification?.verdict).toBe(
      'unverified',
    );
  });
});

describe('getStoryById and executionsFor', () => {
  const snapshot = readSnapshot({
    stories: [{ id: 'US-1', title: 'One' }],
    executions: [
      { id: 'e1', purpose: 'execute', storyIds: ['US-1'] },
      { id: 'e2', purpose: 'review', storyIds: [] },
    ],
  });

  it('is the single point of access to one story', () => {
    expect(getStoryById(snapshot, 'US-1')?.title).toBe('One');
    expect(getStoryById(snapshot, 'US-9')).toBeNull();
    expect(getStoryById(null, 'US-1')).toBeNull();
  });

  it('correlates invocations by purpose for a phase and by id for a story', () => {
    expect(executionsFor(snapshot, 'phase', 'review').map((e) => e.id)).toEqual(['e2']);
    expect(executionsFor(snapshot, 'story', 'US-1').map((e) => e.id)).toEqual(['e1']);
  });
});
