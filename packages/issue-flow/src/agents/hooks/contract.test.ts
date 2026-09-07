import { describe, expect, it } from 'vitest';
import { parseAgentRuntimeEvent } from './contract.js';

/**
 * Ported from WebMux `backend/src/__tests__/runtime-events.test.ts` @ d8c9d5f
 * (2 cases). The correlation keys are Issue Flow's (`runId` + `phase`) instead
 * of the upstream's (`worktreeId` + `branch`) — §18 — but every acceptance and
 * rejection the upstream asserts is asserted here on the equivalent shape.
 */
describe('parseAgentRuntimeEvent', () => {
  it('parses valid runtime events', () => {
    expect(
      parseAgentRuntimeEvent({
        runId: 'run_search',
        phase: 'execute',
        type: 'agent_status_changed',
        lifecycle: 'idle',
      }),
    ).toEqual({
      runId: 'run_search',
      phase: 'execute',
      type: 'agent_status_changed',
      lifecycle: 'idle',
    });
  });

  it('rejects malformed runtime events', () => {
    expect(parseAgentRuntimeEvent(null)).toBeNull();
    expect(parseAgentRuntimeEvent([])).toBeNull();
    expect(
      parseAgentRuntimeEvent({ runId: 'run_search', phase: 'execute', type: 'agent_started' }),
    ).toBeNull();
    expect(
      parseAgentRuntimeEvent({
        runId: 'run_search',
        phase: 'execute',
        type: 'title_changed',
        title: 'ignored',
      }),
    ).toBeNull();
    expect(
      parseAgentRuntimeEvent({
        runId: 'run_search',
        phase: 'execute',
        type: 'agent_status_changed',
        lifecycle: 'closed',
      }),
    ).toBeNull();
    expect(
      parseAgentRuntimeEvent({ runId: 'run_search', phase: 'execute', type: 'runtime_error' }),
    ).toBeNull();
  });

  it('rejects an event with no correlation, which could only be applied by guessing', () => {
    expect(parseAgentRuntimeEvent({ phase: 'execute', type: 'agent_stopped' })).toBeNull();
    expect(
      parseAgentRuntimeEvent({ runId: '', phase: 'execute', type: 'agent_stopped' }),
    ).toBeNull();
    expect(parseAgentRuntimeEvent({ runId: 'run_a', phase: '', type: 'agent_stopped' })).toBeNull();
  });

  it('keeps occurredAt when the producer stamped one and drops anything else', () => {
    expect(
      parseAgentRuntimeEvent({
        runId: 'run_a',
        phase: 'execute',
        type: 'pr_opened',
        url: 'https://github.com/acme/repo/pull/7',
        occurredAt: '2026-09-06T10:00:00.000Z',
        somethingElse: 'dropped',
      }),
    ).toEqual({
      runId: 'run_a',
      phase: 'execute',
      type: 'pr_opened',
      url: 'https://github.com/acme/repo/pull/7',
      occurredAt: '2026-09-06T10:00:00.000Z',
    });
  });
});
