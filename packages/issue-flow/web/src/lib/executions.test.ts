import { describe, expect, it } from 'vitest';
import {
  ALL_PROJECTS,
  activeWorkGroups,
  filterHistory,
  filterLogs,
  REFRESH_PAUSED,
  refreshOptions,
  resolveExecutionView,
  summarizeSessions,
  visibleSessions,
} from './executions';
import type { AgentSessionRow, ProjectSummary, SessionSummary } from './types';

/**
 * **U1** (the dashboard's rules), **U11** (the journal filter) and **U16** (the
 * refresh options).
 */

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'run-1',
    projectId: 'proj-a',
    issueNumber: 1,
    issueTitle: 'Uma issue',
    issueDescription: null,
    repositoryName: 'owner/repo',
    currentPhase: 'execute',
    progressPercent: 50,
    elapsedSeconds: 10,
    status: 'running',
    startedAt: null,
    updatedAt: null,
    retries: null,
    correctionCycle: null,
    attempt: null,
    provider: null,
    lastFailureKind: null,
    cooldownUntil: null,
    lastActivityAt: null,
    agentLifecycle: null,
    awaitingInputCount: null,
    awaitingInputEscalatedAt: null,
    humanHold: null,
    statusUrl: '/api/status?session=run-1',
    eventsUrl: '/api/events?session=run-1',
    ...overrides,
  };
}

function project(id: string, name = ''): ProjectSummary {
  return {
    id,
    prefix: id,
    name,
    root: `/tmp/${id}`,
    source: 'registry',
    active: true,
    served: true,
    addedAt: null,
    lastSeenAt: null,
  };
}

describe('resolveExecutionView (U1)', () => {
  it('opens straight into the detail with a single execution', () => {
    const view = resolveExecutionView({
      sessions: [session()],
      selectedSessionId: null,
      selectedProjectId: ALL_PROJECTS,
      projectCount: 1,
    });
    expect(view.mode).toBe('detail');
    expect(view.session?.sessionId).toBe('run-1');
  });

  it('lists cards with two or more', () => {
    const view = resolveExecutionView({
      sessions: [session(), session({ sessionId: 'run-2' })],
      selectedSessionId: null,
      selectedProjectId: ALL_PROJECTS,
      projectCount: 1,
    });
    expect(view.mode).toBe('dashboard');
    expect(view.session).toBeNull();
  });

  it('opens the detail on none, rather than an empty dashboard', () => {
    const view = resolveExecutionView({
      sessions: [],
      selectedSessionId: null,
      selectedProjectId: ALL_PROJECTS,
      projectCount: 1,
    });
    expect(view.mode).toBe('detail');
    expect(view.session).toBeNull();
  });

  it('makes the consolidated view the home screen with several projects', () => {
    // §47.4: with more than one project the question is "what is happening, and
    // in which project", and that is true with one execution too.
    const view = resolveExecutionView({
      sessions: [session()],
      selectedSessionId: null,
      selectedProjectId: ALL_PROJECTS,
      projectCount: 3,
    });
    expect(view.mode).toBe('dashboard');
  });

  it('honours an explicit choice over everything else', () => {
    const view = resolveExecutionView({
      sessions: [session(), session({ sessionId: 'run-2' })],
      selectedSessionId: 'run-2',
      selectedProjectId: ALL_PROJECTS,
      projectCount: 4,
    });
    expect(view.mode).toBe('detail');
    expect(view.session?.sessionId).toBe('run-2');
  });

  it('drops a choice whose execution is gone instead of pointing at nothing', () => {
    const view = resolveExecutionView({
      sessions: [session()],
      selectedSessionId: 'run-9',
      selectedProjectId: ALL_PROJECTS,
      projectCount: 1,
    });
    expect(view.selectedSessionId).toBeNull();
    expect(view.session?.sessionId).toBe('run-1');
  });
});

function freeSession(overrides: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    id: 's-1',
    projectId: 'proj-a',
    branch: 'session/scratch',
    provider: 'codex',
    label: null,
    status: 'running',
    runId: null,
    free: true,
    ...overrides,
  };
}

describe('visibleSessions and activeWorkGroups', () => {
  it('filters by project, and shows everything with no filter', () => {
    const sessions = [session(), session({ sessionId: 'run-2', projectId: 'proj-b' })];
    expect(visibleSessions(sessions, ALL_PROJECTS)).toHaveLength(2);
    expect(visibleSessions(sessions, 'proj-b').map((s) => s.sessionId)).toEqual(['run-2']);
  });

  it('keeps a project with no execution at all as its own block', () => {
    // The case that was impossible to represent before the registry existed.
    const groups = activeWorkGroups({
      sessions: [session()],
      projects: [project('proj-a', 'A'), project('proj-b', 'B')],
      selectedProjectId: ALL_PROJECTS,
    });
    expect(groups.map((group) => group.label)).toEqual(['A', 'B']);
    expect(groups[1].sessions).toEqual([]);
  });

  it('keeps a session whose project the registry does not know', () => {
    // The outside world is the authority over what exists (ADR-08), not the
    // registry — so it is grouped, never hidden.
    const groups = activeWorkGroups({
      sessions: [session({ projectId: 'unknown' })],
      projects: [project('proj-a', 'A')],
      selectedProjectId: ALL_PROJECTS,
    });
    expect(groups.at(-1)?.label).toBe('Outros projetos');
    expect(groups.at(-1)?.sessions).toHaveLength(1);
  });

  /**
   * I5 — the view answers "what is running anywhere", and a session with no run
   * behind it is work in flight too (§49.4).
   */
  it('puts a project’s free sessions in the same block as its executions', () => {
    const groups = activeWorkGroups({
      sessions: [session()],
      projects: [project('proj-a', 'A'), project('proj-b', 'B')],
      selectedProjectId: ALL_PROJECTS,
      agentSessions: [freeSession(), freeSession({ id: 's-2', projectId: 'proj-b' })],
    });
    expect(groups[0].sessions).toHaveLength(1);
    expect(groups[0].freeSessions.map((row) => row.id)).toEqual(['s-1']);
    expect(groups[1].sessions).toEqual([]);
    expect(groups[1].freeSessions.map((row) => row.id)).toEqual(['s-2']);
  });

  it('never repeats a session that is already on screen as its execution', () => {
    const groups = activeWorkGroups({
      sessions: [session()],
      projects: [project('proj-a', 'A'), project('proj-b', 'B')],
      selectedProjectId: ALL_PROJECTS,
      agentSessions: [freeSession({ runId: 'run-1', free: false })],
    });
    expect(groups[0].freeSessions).toEqual([]);
  });

  it('honours the project filter for sessions exactly as it does for executions', () => {
    const groups = activeWorkGroups({
      sessions: [],
      projects: [project('proj-a', 'A'), project('proj-b', 'B')],
      selectedProjectId: 'proj-b',
      agentSessions: [freeSession(), freeSession({ id: 's-2', projectId: 'proj-b' })],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].freeSessions.map((row) => row.id)).toEqual(['s-2']);
  });
});

describe('summarizeSessions', () => {
  it('counts executions in the feminine, with one term per state', () => {
    expect(
      summarizeSessions([
        session(),
        session({ sessionId: 'run-2', status: 'completed' }),
        session({ sessionId: 'run-3', status: 'completed' }),
      ]),
    ).toBe('3 execuções · 1 em execução · 2 concluídas');
  });

  it('agrees in the singular', () => {
    expect(summarizeSessions([session({ status: 'completed' })])).toBe('1 execução · 1 concluída');
  });
});

describe('filterHistory (U11)', () => {
  const entries = [
    { seq: 1, event: { type: 'phase:start', phase: 'execute' } },
    { seq: 2, event: { type: 'retry', attempt: 1 } },
    { seq: 3, event: { type: 'failover', from: 'a', to: 'b' } },
    { seq: 4, event: {} },
  ];

  it('splits resilience from pipeline, and drops an entry with no type', () => {
    expect(filterHistory(entries, 'all').map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(filterHistory(entries, 'resilience').map((e) => e.seq)).toEqual([2, 3]);
    expect(filterHistory(entries, 'pipeline').map((e) => e.seq)).toEqual([1]);
  });
});

describe('filterLogs (U14)', () => {
  it('filters by level and keeps everything on "all"', () => {
    const logs = [{ level: 'info' }, { level: 'warn' }, { level: 'error' }];
    expect(filterLogs(logs, 'all')).toHaveLength(3);
    expect(filterLogs(logs, 'warn')).toEqual([{ level: 'warn' }]);
  });
});

describe('refreshOptions (U16)', () => {
  it('offers 3/5/10/30 and keeps a server-suggested value that is not among them', () => {
    expect(refreshOptions(5)).toEqual([3, 5, 10, 30]);
    expect(refreshOptions(7)).toEqual([3, 5, 7, 10, 30]);
    expect(refreshOptions(REFRESH_PAUSED)).toEqual([3, 5, 10, 30]);
  });
});
