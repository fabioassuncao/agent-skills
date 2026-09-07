import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type PlanRepositoryContext,
  resetPlanRepositories,
  saveAgentSession,
} from '../../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../../storage/paths.js';
import {
  createAgentSession,
  listSessions,
  loadSession,
  recordConversationId,
  removeSession,
  saveSession,
  updateSessionStatus,
} from './store.js';

/** The storage boundary of `AgentSession`, against a real database. */
describe('agent session store', () => {
  let home: string;
  let context: PlanRepositoryContext;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-agent-session-'));
    context = {
      tasksPath: join(home, 'projects', 'proj', 'issues', '1', 'tasks.json'),
      projectId: 'proj',
      issueId: '1',
      projectRoot: '/repo',
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
  });

  afterEach(async () => {
    resetPlanRepositories();
    await rm(home, { recursive: true, force: true });
  });

  it('stamps a fresh session and reads it back whole', async () => {
    const session = createAgentSession({
      branch: 'feature',
      provider: 'claude',
      permission: 'read-only',
      runId: 'run-1',
      phase: 'execute',
      worktreeId: 'wt-1',
      paneTarget: 'if-proj:if-feature.0',
      now: () => new Date('2026-09-06T10:00:00.000Z'),
    });

    expect(session).toMatchObject({
      runId: 'run-1',
      phase: 'execute',
      storyId: null,
      conversationId: null,
      status: 'starting',
      permission: 'read-only',
      createdAt: '2026-09-06T10:00:00.000Z',
      endedAt: null,
    });

    await saveSession(context, session);
    await expect(loadSession(context, session.id)).resolves.toEqual(session);
  });

  // ADR-16: a free session is the same entity with those columns empty.
  it('persists a session with no run, phase or story', async () => {
    const free = createAgentSession({ branch: 'feature', provider: 'codex' });
    await saveSession(context, free);
    await expect(loadSession(context, free.id)).resolves.toMatchObject({
      runId: null,
      phase: null,
      storyId: null,
    });
  });

  it('lists by branch and by run, newest first', async () => {
    const first = createAgentSession({
      branch: 'a',
      provider: 'claude',
      runId: 'run-1',
      now: () => new Date('2026-09-06T10:00:00.000Z'),
    });
    const second = createAgentSession({
      branch: 'b',
      provider: 'claude',
      runId: 'run-2',
      now: () => new Date('2026-09-06T12:00:00.000Z'),
    });
    await saveSession(context, first);
    await saveSession(context, second);

    expect((await listSessions(context)).map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect((await listSessions(context, { branch: 'a' })).map((entry) => entry.id)).toEqual([
      first.id,
    ]);
    expect((await listSessions(context, { runId: 'run-2' })).map((entry) => entry.id)).toEqual([
      second.id,
    ]);
  });

  // It is the field that decides whether a session can be resumed at all, and
  // it only arrives once the provider has actually created the conversation.
  it('records the provider conversation id when it becomes known', async () => {
    const session = createAgentSession({ branch: 'feature', provider: 'claude' });
    await saveSession(context, session);

    const updated = await recordConversationId(context, session, 'conv-1');
    expect(updated.conversationId).toBe('conv-1');
    await expect(loadSession(context, session.id)).resolves.toMatchObject({
      conversationId: 'conv-1',
    });
  });

  it('stamps endedAt when a session stops, and only then', async () => {
    const session = createAgentSession({ branch: 'feature', provider: 'claude' });
    await saveSession(context, session);

    const running = await updateSessionStatus(context, session, 'running');
    expect(running.endedAt).toBeNull();

    const stopped = await updateSessionStatus(context, running, 'stopped');
    expect(stopped.endedAt).not.toBeNull();
    await expect(loadSession(context, session.id)).resolves.toMatchObject({ status: 'stopped' });
  });

  it('forgets a session when asked', async () => {
    const session = createAgentSession({ branch: 'feature', provider: 'claude' });
    await saveSession(context, session);
    await removeSession(context, session.id);
    await expect(loadSession(context, session.id)).resolves.toBeNull();
  });

  it('keeps a custom-agent id because the registry is intentionally open', async () => {
    const session = createAgentSession({ branch: 'feature', provider: 'claude' });
    await saveAgentSession(context, { ...session, provider: 'some-future-agent' });

    await expect(loadSession(context, session.id)).resolves.toMatchObject({
      provider: 'some-future-agent',
    });
    await expect(listSessions(context)).resolves.toHaveLength(1);
  });

  it('keeps a row whose phase this release does not know, without the phase', async () => {
    const session = createAgentSession({ branch: 'feature', provider: 'claude' });
    await saveAgentSession(context, { ...session, phase: 'some-future-phase' });

    await expect(loadSession(context, session.id)).resolves.toMatchObject({ phase: null });
  });
});
