import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setSessionPublisher } from '../../core/session-publisher.js';
import { MemoryPublisher } from '../../core/session-state.js';
import { applyAgentRuntimeEvent } from './apply.js';

/**
 * The projection §18 of the absorption plan specifies: the four upstream event
 * types land on the session events Issue Flow already has, and the two new ones
 * are additive.
 */
describe('applyAgentRuntimeEvent', () => {
  let publisher: MemoryPublisher;

  beforeEach(() => {
    publisher = new MemoryPublisher({ onWarn: () => {} });
    publisher.publish({
      type: 'session:start',
      at: '2026-09-06T10:00:00.000Z',
      sessionId: 'run-1',
      issueNumber: 42,
      phases: ['execute'],
    });
    setSessionPublisher(publisher);
  });

  afterEach(() => {
    setSessionPublisher(undefined);
  });

  function event(overrides: Record<string, unknown>) {
    return {
      runId: 'run-1',
      phase: 'execute',
      occurredAt: '2026-09-06T10:00:01.000Z',
      ...overrides,
    } as Parameters<typeof applyAgentRuntimeEvent>[0];
  }

  it('projects idle onto awaiting-input, the state headless could not see before', async () => {
    await applyAgentRuntimeEvent(event({ type: 'agent_status_changed', lifecycle: 'idle' }));

    const snapshot = publisher.snapshot();
    expect(snapshot.agent).toMatchObject({
      lifecycle: 'awaiting-input',
      phase: 'execute',
      since: '2026-09-06T10:00:01.000Z',
      awaitingInputCount: 1,
    });
    // Also a log line: headless has no dashboard open by default and this is
    // the one state in which the run stops progressing until someone acts.
    expect(snapshot.warnings.map((entry) => entry.message)).toEqual([
      "Agent is waiting for input during 'execute'.",
    ]);
  });

  it('projects running and starting onto busy, and clears awaiting-input', async () => {
    await applyAgentRuntimeEvent(event({ type: 'agent_status_changed', lifecycle: 'idle' }));
    await applyAgentRuntimeEvent(event({ type: 'agent_status_changed', lifecycle: 'running' }));
    expect(publisher.snapshot().agent.lifecycle).toBe('busy');

    await applyAgentRuntimeEvent(event({ type: 'agent_status_changed', lifecycle: 'starting' }));
    expect(publisher.snapshot().agent.lifecycle).toBe('busy');
  });

  it('counts a human block once per transition, not once per report', async () => {
    await applyAgentRuntimeEvent(event({ type: 'agent_status_changed', lifecycle: 'idle' }));
    await applyAgentRuntimeEvent(event({ type: 'agent_status_changed', lifecycle: 'idle' }));
    expect(publisher.snapshot().agent.awaitingInputCount).toBe(1);

    await applyAgentRuntimeEvent(event({ type: 'agent_status_changed', lifecycle: 'running' }));
    await applyAgentRuntimeEvent(event({ type: 'agent_status_changed', lifecycle: 'idle' }));
    expect(publisher.snapshot().agent.awaitingInputCount).toBe(2);
  });

  // `stopped` and `agent_stopped` are already reported by the invocation
  // ending. A second source for the same fact is a second thing to keep
  // consistent, so they leave the projection alone.
  it('leaves the lifecycle alone for stopped, which the end of the invocation already reports', async () => {
    await applyAgentRuntimeEvent(event({ type: 'agent_status_changed', lifecycle: 'running' }));
    await applyAgentRuntimeEvent(event({ type: 'agent_status_changed', lifecycle: 'stopped' }));
    await applyAgentRuntimeEvent(event({ type: 'agent_stopped' }));
    expect(publisher.snapshot().agent.lifecycle).toBe('busy');
  });

  it('folds a hook-reported pull request into the list the pr phase writes', async () => {
    await applyAgentRuntimeEvent(
      event({ type: 'pr_opened', url: 'https://github.com/acme/repo/pull/17' }),
    );
    expect(publisher.snapshot().pullRequests).toEqual([
      { number: 17, url: 'https://github.com/acme/repo/pull/17', title: '' },
    ]);

    // Reported twice — by the hook and by the phase — is still one pull request.
    await applyAgentRuntimeEvent(
      event({ type: 'pr_opened', url: 'https://github.com/acme/repo/pull/17' }),
    );
    expect(publisher.snapshot().pullRequests).toHaveLength(1);
  });

  it('reports a runtime error as an error log rather than inventing a failure', async () => {
    await applyAgentRuntimeEvent(event({ type: 'runtime_error', message: 'hook could not run' }));
    expect(publisher.snapshot().errors.map((entry) => entry.message)).toEqual([
      'hook could not run',
    ]);
  });

  // Hooks outlive one invocation. Applying an event from a run that is over
  // would move a live run's state on evidence from a dead one.
  it('drops an event correlated to a different run', async () => {
    const warnings: string[] = [];
    await applyAgentRuntimeEvent(
      event({ runId: 'another-run', type: 'agent_status_changed', lifecycle: 'idle' }),
      { onWarn: (message) => warnings.push(message) },
    );

    expect(publisher.snapshot().agent.lifecycle).toBeNull();
    expect(warnings.join('\n')).toContain('another-run');
  });
});
