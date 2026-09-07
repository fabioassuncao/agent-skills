import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExecutionsDashboard from './ExecutionsDashboard.svelte';
import { ALL_PROJECTS } from './executions';
import type { ProjectSummary, SessionSummary } from './types';

/** **U1** — the dashboard of executions, on screen. */

const NOW = Date.parse('2026-09-06T10:05:00.000Z');

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'run-1',
    projectId: 'proj-a',
    issueNumber: 42,
    issueTitle: 'Absorver o painel',
    issueDescription:
      'Uma descrição bem comprida da issue que precisa ser truncada em algum ponto.',
    repositoryName: 'owner/repo',
    currentPhase: 'execute',
    progressPercent: 40,
    elapsedSeconds: 300,
    status: 'running',
    startedAt: '2026-09-06T10:00:00.000Z',
    updatedAt: '2026-09-06T10:04:00.000Z',
    retries: 2,
    correctionCycle: 1,
    attempt: 3,
    provider: 'claude',
    lastFailureKind: null,
    cooldownUntil: null,
    lastActivityAt: '2026-09-06T10:04:30.000Z',
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

function renderDashboard(props: Record<string, unknown> = {}) {
  const onselect = vi.fn();
  const onprojectchange = vi.fn();
  const onrefreshchange = vi.fn();
  render(ExecutionsDashboard, {
    props: {
      sessions: [session(), session({ sessionId: 'run-2', issueNumber: 43, status: 'completed' })],
      projects: [],
      selectedProjectId: ALL_PROJECTS,
      refreshSeconds: 5,
      now: NOW,
      onselect,
      onprojectchange,
      onrefreshchange,
      ...props,
    },
  });
  return { onselect, onprojectchange, onrefreshchange };
}

afterEach(cleanup);

describe('the executions dashboard (U1)', () => {
  it('renders one card per active execution, and summarises them', () => {
    renderDashboard();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Trabalho ativo');
    // The brand is in the document title, never in the heading.
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent('issue-flow');
    expect(screen.getByText('2 execuções · 1 em execução · 1 concluída')).toBeInTheDocument();

    const cards = screen.getAllByRole('button').filter((node) => node.dataset.sessionId);
    expect(cards).toHaveLength(2);
  });

  it('makes every card a button whose content is phrasing content', () => {
    renderDashboard();
    const card = screen
      .getAllByRole('button')
      .find((node) => node.dataset.sessionId === 'run-1') as HTMLElement;
    expect(card.tagName).toBe('BUTTON');
    expect(card.querySelector('p, div')).toBeNull();
  });

  it('carries the resilience metadata a percentage alone cannot express', () => {
    renderDashboard();
    const card = screen
      .getAllByRole('button')
      .find((node) => node.dataset.sessionId === 'run-1') as HTMLElement;

    expect(within(card).getByText('Fase: execute')).toBeInTheDocument();
    expect(within(card).getByText('40%')).toBeInTheDocument();
    expect(within(card).getByText('5min 00s')).toBeInTheDocument();
    expect(within(card).getByText('2 retry(s)')).toBeInTheDocument();
    expect(within(card).getByText('correção 1')).toBeInTheDocument();
    expect(within(card).getByText('tentativa 3')).toBeInTheDocument();
    expect(within(card).getByText('provider claude')).toBeInTheDocument();
    expect(within(card).getByText('ao vivo')).toBeInTheDocument();
  });

  it('truncates the description rather than letting a card grow without bound', () => {
    renderDashboard({
      sessions: [session({ issueDescription: 'x'.repeat(400) })],
    });
    const summary = screen.getByText(/^x+…$/);
    expect(summary.textContent?.length).toBe(140);
  });

  it('opens an execution when its card is clicked', async () => {
    const { onselect } = renderDashboard();
    const card = screen
      .getAllByRole('button')
      .find((node) => node.dataset.sessionId === 'run-2') as HTMLElement;
    await fireEvent.click(card);
    expect(onselect).toHaveBeenCalledWith('run-2');
  });

  it('says so plainly when there is no execution at all', () => {
    renderDashboard({ sessions: [] });
    expect(screen.getByText('Nenhuma execução ativa')).toBeInTheDocument();
  });

  it('hides the project selector on a single-project monitor', () => {
    renderDashboard({ projects: [project('proj-a', 'A')] });
    expect(screen.queryByLabelText('Projeto exibido')).not.toBeInTheDocument();
  });

  it('groups by project, keeping one with no execution, when there are several', async () => {
    const { onprojectchange } = renderDashboard({
      sessions: [session()],
      projects: [project('proj-a', 'A'), project('proj-b', 'B')],
    });

    expect(screen.getByRole('heading', { name: 'A' })).toBeInTheDocument();
    const empty = screen.getByRole('heading', { name: 'B' }).closest('section') as HTMLElement;
    expect(within(empty).getByText('Nenhuma execução ativa.')).toBeInTheDocument();

    await fireEvent.change(screen.getByLabelText('Projeto exibido'), {
      target: { value: 'proj-b' },
    });
    expect(onprojectchange).toHaveBeenCalledWith('proj-b');
  });

  it('shows the §32 escalation on the card, distinct from "aguardando você"', () => {
    renderDashboard({
      sessions: [
        session({ agentLifecycle: 'awaiting-input' }),
        session({
          sessionId: 'run-2',
          agentLifecycle: 'awaiting-input',
          awaitingInputEscalatedAt: '2026-09-06T10:05:00.000Z',
        }),
      ],
    });
    expect(screen.getByText('aguardando você')).toBeInTheDocument();
    expect(screen.getByText('ninguém respondeu')).toBeInTheDocument();
  });

  it('says when a person is driving a run that only looks idle', () => {
    renderDashboard({
      sessions: [session({ humanHold: { since: '2026-09-06T10:04:00.000Z', reason: 'takeover' } })],
    });
    expect(screen.getByText('em controle humano')).toBeInTheDocument();
  });
});

/**
 * I5 — "Trabalho ativo" shows Tasks **and** sessions, from several projects.
 *
 * §49.4 draws exactly this: a block per project, each with its executions and
 * its free sessions. The executions half already existed; the sessions half is
 * what phase 8D added, and both live in the same block because "what is running
 * anywhere" is one question, not two screens.
 */
describe('the consolidated view (I5, §49.4)', () => {
  function freeSession(overrides: Record<string, unknown> = {}) {
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

  it('lists a project’s free sessions beside its executions', () => {
    renderDashboard({
      projects: [project('proj-a', 'Alpha'), project('proj-b', 'Beta')],
      sessions: [session({ projectId: 'proj-a' })],
      agentSessions: [
        freeSession(),
        freeSession({ id: 's-2', projectId: 'proj-b', label: 'rascunho', provider: 'claude' }),
      ],
    });

    const alpha = screen.getByRole('heading', { name: 'Alpha' }).closest('section') as HTMLElement;
    expect(within(alpha).getByText('#42')).toBeInTheDocument();
    expect(within(alpha).getByText('session/scratch')).toBeInTheDocument();
    expect(within(alpha).getByText('sessão · codex')).toBeInTheDocument();

    const beta = screen.getByRole('heading', { name: 'Beta' }).closest('section') as HTMLElement;
    // A project with no execution still shows its session — the case that could
    // not be represented before the registry existed.
    expect(within(beta).getByText('Nenhuma execução ativa.')).toBeInTheDocument();
    expect(within(beta).getByText('rascunho')).toBeInTheDocument();
  });

  it('never lists a session that already appears as its execution', () => {
    renderDashboard({
      projects: [project('proj-a', 'Alpha'), project('proj-b', 'Beta')],
      sessions: [session({ projectId: 'proj-a' })],
      agentSessions: [freeSession({ id: 's-3', runId: 'run-1', free: false })],
    });
    expect(screen.queryByText('session/scratch')).not.toBeInTheDocument();
  });

  it('shows the sessions on a single-project monitor too', () => {
    renderDashboard({
      projects: [project('proj-a', 'Alpha')],
      sessions: [],
      agentSessions: [freeSession()],
    });
    expect(screen.getByText('Nenhuma execução ativa.')).toBeInTheDocument();
    expect(screen.getByText('session/scratch')).toBeInTheDocument();
  });

  it('opens a session from its row, and offers nothing to click without the surface', async () => {
    const onselectsession = vi.fn();
    renderDashboard({
      projects: [project('proj-a', 'Alpha')],
      sessions: [],
      agentSessions: [freeSession()],
      onselectsession,
    });

    await fireEvent.click(screen.getByText('session/scratch'));
    expect(onselectsession).toHaveBeenCalledWith('session/scratch');

    cleanup();
    renderDashboard({
      projects: [project('proj-a', 'Alpha')],
      sessions: [],
      agentSessions: [freeSession()],
      onselectsession: null,
    });
    expect(screen.getByText('session/scratch').closest('button')).toBeDisabled();
  });

  // Every card on this screen is a `<button>` with only phrasing content: a
  // `<div>` inside a button is invalid HTML the browser "fixes" by breaking the
  // click target.
  it('makes each session row a real button with phrasing content only', () => {
    renderDashboard({
      projects: [project('proj-a', 'Alpha')],
      sessions: [],
      agentSessions: [freeSession()],
      onselectsession: vi.fn(),
    });
    const row = screen.getByText('session/scratch').closest('button') as HTMLElement;
    expect(row.tagName).toBe('BUTTON');
    expect(row.querySelector('p, div')).toBeNull();
  });
});
