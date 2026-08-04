import { afterEach, describe, expect, it } from 'vitest';
import {
  publishIterationMetrics,
  publishPhaseMetrics,
  publishStoryMetrics,
} from './session-metrics.js';
import { setSessionPublisher } from './session-publisher.js';
import { MemoryPublisher, type SessionEvent } from './session-state.js';

/**
 * Recording publisher: keeps every event so the tests can assert on the exact
 * payload the commands emit, not only on its effect over the snapshot.
 */
class RecordingPublisher extends MemoryPublisher {
  readonly events: SessionEvent[] = [];

  protected override afterPublish(event: SessionEvent): void {
    this.events.push(event);
  }
}

function install(): RecordingPublisher {
  const publisher = new RecordingPublisher({ onWarn: () => {} });
  setSessionPublisher(publisher);
  return publisher;
}

afterEach(() => {
  setSessionPublisher(undefined);
});

describe('publishPhaseMetrics', () => {
  it('publishes a phase-scoped metrics event with the reported fields', () => {
    const publisher = install();

    publishPhaseMetrics('prd', {
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 500,
      cacheCreationTokens: 60,
      costUsd: 0.1234,
    });

    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]).toMatchObject({
      type: 'metrics:update',
      scope: 'phase',
      phase: 'prd',
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 500,
      cacheCreationTokens: 60,
      costUsd: 0.1234,
    });
  });

  it('carries the invocation duration when a start mark is given', () => {
    const publisher = install();

    publishPhaseMetrics('review', { inputTokens: 1 }, Date.now() - 3_000);

    const event = publisher.events[0] as Extract<SessionEvent, { type: 'metrics:update' }>;
    expect(event.durationSeconds).toBeGreaterThanOrEqual(2);
    expect(event.durationSeconds).toBeLessThanOrEqual(4);
  });

  it('omits durationSeconds when no start mark is given', () => {
    const publisher = install();

    publishPhaseMetrics('review', { inputTokens: 1 });

    const event = publisher.events[0] as Extract<SessionEvent, { type: 'metrics:update' }>;
    expect(event.durationSeconds).toBeUndefined();
  });

  it('publishes only the fields the CLI reported, leaving the rest undefined', () => {
    const publisher = install();

    publishPhaseMetrics('plan', { outputTokens: 7 });

    const event = publisher.events[0] as Extract<SessionEvent, { type: 'metrics:update' }>;
    expect(event.outputTokens).toBe(7);
    expect(event.inputTokens).toBeUndefined();
    expect(event.costUsd).toBeUndefined();
  });

  it('publishes nothing when the CLI reported no usage at all', () => {
    const publisher = install();

    publishPhaseMetrics('pr', null);
    publishPhaseMetrics('pr', undefined);
    publishPhaseMetrics('pr', {});

    expect(publisher.events).toHaveLength(0);
    expect(publisher.version()).toBe(0);
  });

  it('keeps an explicitly reported zero — it is a value, not an absence', () => {
    const publisher = install();

    publishPhaseMetrics('pr', { costUsd: 0 });

    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]).toMatchObject({ costUsd: 0 });
  });

  it('accumulates one event per invocation into the phase and the aggregate', () => {
    const publisher = install();
    publisher.publish({
      type: 'session:start',
      at: '2026-01-01T00:00:00Z',
      sessionId: 's1',
      issueNumber: 42,
      phases: ['prd', 'plan'],
    });

    publishPhaseMetrics('prd', { inputTokens: 10, costUsd: 0.5 });
    publishPhaseMetrics('prd', { inputTokens: 5, costUsd: 0.25 });

    const snapshot = publisher.snapshot();
    const prd = snapshot.phases.find((p) => p.name === 'prd');
    expect(prd).toMatchObject({ inputTokens: 15, costUsd: 0.75 });
    expect(snapshot.metrics.totalInputTokens).toBe(15);
    expect(snapshot.metrics.totalCostUsd).toBe(0.75);
    // Never reported by these events, so it stays null rather than 0.
    expect(prd?.outputTokens).toBeNull();
  });

  it('is a no-op with the default NullPublisher (monitoring off)', () => {
    setSessionPublisher(undefined);

    expect(() => publishPhaseMetrics('prd', { inputTokens: 1 }, Date.now())).not.toThrow();
  });
});

describe('publishIterationMetrics', () => {
  it('publishes an iteration-scoped event pinned to the execute phase', () => {
    const publisher = install();

    publishIterationMetrics(3, { inputTokens: 100, costUsd: 0.2 }, 42);

    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]).toMatchObject({
      type: 'metrics:update',
      scope: 'iteration',
      phase: 'execute',
      iteration: 3,
      inputTokens: 100,
      costUsd: 0.2,
      durationSeconds: 42,
    });
  });

  it('feeds the execute phase and the issue-wide aggregate', () => {
    const publisher = install();
    publisher.publish({
      type: 'session:start',
      at: '2026-01-01T00:00:00Z',
      sessionId: 's1',
      issueNumber: 42,
      phases: ['execute'],
    });

    publishIterationMetrics(1, { inputTokens: 10, costUsd: 0.5 }, 30);
    publishIterationMetrics(2, { inputTokens: 4, costUsd: 0.25 }, 20);

    const snapshot = publisher.snapshot();
    const execute = snapshot.phases.find((p) => p.name === 'execute');
    expect(execute).toMatchObject({ inputTokens: 14, costUsd: 0.75 });
    expect(snapshot.metrics.totalInputTokens).toBe(14);
    expect(snapshot.metrics.totalCostUsd).toBe(0.75);
    // Wall-clock time of a phase keeps coming from phase:start/phase:end only.
    expect(execute?.durationSeconds).toBeNull();
  });

  it('publishes nothing when the CLI reported no usage', () => {
    const publisher = install();

    publishIterationMetrics(1, null, 30);
    publishIterationMetrics(2, {}, 30);

    expect(publisher.events).toHaveLength(0);
  });
});

describe('publishStoryMetrics', () => {
  it('publishes a story-scoped event with the rateio and the duration', () => {
    const publisher = install();

    publishStoryMetrics('US-007', { inputTokens: 50, costUsd: 0.1 }, 15);

    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]).toMatchObject({
      type: 'metrics:update',
      scope: 'story',
      storyId: 'US-007',
      inputTokens: 50,
      costUsd: 0.1,
      durationSeconds: 15,
    });
  });

  it('lands on the story alone, never on the phase nor the aggregate', () => {
    const publisher = install();
    publisher.publish({
      type: 'session:start',
      at: '2026-01-01T00:00:00Z',
      sessionId: 's1',
      issueNumber: 42,
      phases: ['execute'],
    });
    publisher.publish({
      type: 'stories:update',
      at: '2026-01-01T00:01:00Z',
      stories: [
        {
          id: 'US-007',
          title: 'Story',
          description: '',
          acceptanceCriteria: [],
          priority: 1,
          passes: true,
          notes: '',
        },
      ],
    });

    publishStoryMetrics('US-007', { inputTokens: 50 }, 15);

    const snapshot = publisher.snapshot();
    expect(snapshot.stories[0]).toMatchObject({ inputTokens: 50, durationSeconds: 15 });
    expect(snapshot.phases.find((p) => p.name === 'execute')?.inputTokens).toBeNull();
    expect(snapshot.metrics.totalInputTokens).toBeNull();
  });

  it('still publishes the duration when the CLI reported no usage', () => {
    const publisher = install();

    publishStoryMetrics('US-007', null, 12);

    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]).toMatchObject({ scope: 'story', durationSeconds: 12 });
  });

  it('publishes nothing when there is neither usage nor duration', () => {
    const publisher = install();

    publishStoryMetrics('US-007', null, undefined);
    publishStoryMetrics('US-007', {}, undefined);

    expect(publisher.events).toHaveLength(0);
  });
});
