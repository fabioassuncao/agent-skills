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
