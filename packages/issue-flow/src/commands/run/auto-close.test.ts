import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentSession, listSessions, saveSession } from '../../agents/session/store.js';
import { holdForHuman, releaseHumanHold, resetHumanHoldCache } from '../../core/human-hold.js';
import { resetRunCompletionState } from '../../core/run-completion.js';
import { createInitialSnapshot } from '../../core/session-state.js';
import {
  type PlanRepositoryContext,
  recordAgentEvent,
  resetPlanRepositories,
  saveSessionEvent,
} from '../../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../../storage/paths.js';
import { settleFinishedRun } from './auto-close.js';

/**
 * The end of an autonomous run, end to end against a real database.
 *
 * This is where the two halves of §17 meet: the ported decision
 * (`core/run-completion.ts`) and the disarm that §32 already gave this
 * repository (`core/human-hold.ts`). The rule under test is the one the
 * upstream states in one line — a person touching the keyboard stands
 * everything automatic down — plus the one this repository adds: a headless
 * run has nothing to close and must be untouched by the option existing.
 */
describe('settling a finished run', () => {
  let home: string;
  let context: PlanRepositoryContext;

  async function openSession(status: 'running' | 'stopped' = 'running'): Promise<string> {
    const session = createAgentSession({
      branch: 'feat/42',
      provider: 'claude',
      runId: 'run-1',
      phase: 'execute',
      status,
    });
    await saveSession(context, session);
    return session.id;
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-autoclose-'));
    context = {
      tasksPath: join(home, 'projects', 'proj', 'issues', '42', 'tasks.json'),
      projectId: 'proj',
      issueId: '42',
      projectRoot: '/repo',
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
    resetHumanHoldCache();
    resetRunCompletionState();
    await saveSessionEvent(context, {
      sessionId: 'run-1',
      sequence: 1,
      event: {
        type: 'session:start',
        at: '2026-09-06T10:00:00.000Z',
        sessionId: 'run-1',
        issueNumber: 42,
        phases: ['execute'],
      },
      snapshot: { ...createInitialSnapshot(), sessionId: 'run-1', status: 'running' },
    });
  });

  afterEach(async () => {
    resetHumanHoldCache();
    resetRunCompletionState();
    resetPlanRepositories();
    await rm(home, { recursive: true, force: true });
  });

  it('closes the sessions the run left open when asked to', async () => {
    await openSession();
    const outcome = await settleFinishedRun({
      context,
      runId: 'run-1',
      issueId: '42',
      outcome: 'completed',
      autoClose: true,
    });

    expect(outcome.settled).toBe(true);
    expect(outcome.closedSessions).toBe(1);
    expect((await listSessions(context, { runId: 'run-1' }))[0]?.status).toBe('stopped');
  });

  it('leaves them open by default, which is what every release did', async () => {
    await openSession();
    const outcome = await settleFinishedRun({
      context,
      runId: 'run-1',
      issueId: '42',
      outcome: 'completed',
      autoClose: false,
    });

    expect(outcome.settled).toBe(true);
    expect(outcome.closedSessions).toBe(0);
    expect((await listSessions(context, { runId: 'run-1' }))[0]?.status).toBe('running');
  });

  it('closes nothing when a person took the run over', async () => {
    await openSession();
    await holdForHuman(context, { runId: 'run-1', reason: 'takeover' });

    const outcome = await settleFinishedRun({
      context,
      runId: 'run-1',
      issueId: '42',
      outcome: 'completed',
      autoClose: true,
    });

    expect(outcome.heldByHuman).toBe(true);
    expect(outcome.settled).toBe(false);
    expect(outcome.closedSessions).toBe(0);
    expect((await listSessions(context, { runId: 'run-1' }))[0]?.status).toBe('running');
  });

  it('closes again once control is handed back', async () => {
    await openSession();
    await holdForHuman(context, { runId: 'run-1', reason: 'takeover' });
    await releaseHumanHold(context, 'run-1');
    resetRunCompletionState();

    const outcome = await settleFinishedRun({
      context,
      runId: 'run-1',
      issueId: '42',
      outcome: 'completed',
      autoClose: true,
    });
    expect(outcome.closedSessions).toBe(1);
  });

  it('is a no-op for a headless run, which opens no session at all', async () => {
    const outcome = await settleFinishedRun({
      context,
      runId: 'run-1',
      issueId: '42',
      outcome: 'completed',
      autoClose: true,
    });
    expect(outcome.settled).toBe(true);
    expect(outcome.closedSessions).toBe(0);
  });

  it('never reopens a session that had already stopped', async () => {
    await openSession('stopped');
    const outcome = await settleFinishedRun({
      context,
      runId: 'run-1',
      issueId: '42',
      outcome: 'completed',
      autoClose: true,
    });
    expect(outcome.closedSessions).toBe(0);
  });

  it('settles a failed run too — the option is about sessions, not about success', async () => {
    await openSession();
    const outcome = await settleFinishedRun({
      context,
      runId: 'run-1',
      issueId: '42',
      outcome: 'failed',
      autoClose: true,
    });
    expect(outcome.settled).toBe(true);
    expect(outcome.closedSessions).toBe(1);
  });

  it("reads the agent's own signals without letting them shorten anything", async () => {
    await openSession();
    await recordAgentEvent(context, {
      runId: 'run-1',
      phase: 'execute',
      type: 'pr_opened',
      payload: { url: 'https://github.com/o/r/pull/7' },
      occurredAt: '2026-09-06T10:05:00.000Z',
    });
    await recordAgentEvent(context, {
      runId: 'run-1',
      phase: 'execute',
      type: 'agent_stopped',
      payload: {},
      occurredAt: '2026-09-06T10:06:00.000Z',
    });

    const outcome = await settleFinishedRun({
      context,
      runId: 'run-1',
      issueId: '42',
      outcome: 'completed',
      autoClose: true,
    });
    expect(outcome.settled).toBe(true);
    expect(outcome.closedSessions).toBe(1);
  });
});
