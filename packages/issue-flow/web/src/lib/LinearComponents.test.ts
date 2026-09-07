import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LinearDetailDialog from './LinearDetailDialog.svelte';
import LinearPanel from './LinearPanel.svelte';
import LinearPostDialog from './LinearPostDialog.svelte';
import type { LinearIssue } from './types';

const issue: LinearIssue = {
  id: 'linear-id',
  identifier: 'ENG-42',
  title: 'Conectar painel',
  description: 'Descrição do ticket',
  priority: 2,
  priorityLabel: 'Alta',
  url: 'https://linear/ENG-42',
  branchName: 'eng-42-conectar-painel',
  dueDate: null,
  updatedAt: '2026-09-06T00:00:00Z',
  state: { name: 'A fazer', color: '#ffaa00', type: 'unstarted' },
  team: { name: 'Engenharia', key: 'ENG' },
  labels: [{ name: 'issue-flow', color: '#4488ff' }],
  project: 'Monitor',
};

describe('Linear UI', () => {
  afterEach(cleanup);

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
  });

  it('shows missing credentials and assigned issues in pt-BR', async () => {
    const { rerender } = render(LinearPanel, {
      issues: [],
      availability: 'missing_api_key',
      canAssign: true,
      onassign: vi.fn(),
      onselect: vi.fn(),
    });
    await fireEvent.click(screen.getByRole('button', { name: /Linear/ }));
    expect(screen.getByText(/Defina/)).toBeInTheDocument();

    await rerender({ issues: [issue], availability: 'ready', canAssign: true });
    expect(screen.getByText('Conectar painel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Implementar' })).toBeInTheDocument();
  });

  it('opens issue detail with an implementation action', () => {
    render(LinearDetailDialog, { issue, canAssign: true, onassign: vi.fn(), onclose: vi.fn() });
    expect(screen.getByRole('heading', { name: 'Conectar painel' })).toBeInTheDocument();
    expect(screen.getByText('Descrição do ticket')).toBeInTheDocument();
  });

  it('keeps read-only issue details reachable without offering remote mutations', async () => {
    const onselect = vi.fn();
    const onassign = vi.fn();
    render(LinearPanel, {
      issues: [issue],
      availability: 'ready',
      canAssign: false,
      onassign,
      onselect,
    });
    await fireEvent.click(screen.getByRole('button', { name: /Linear/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Ver detalhes de ENG-42' }));
    expect(onselect).toHaveBeenCalledWith(issue);
    expect(onassign).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Implementar' })).not.toBeInTheDocument();
  });

  it('validates a team and submits a new-ticket target', async () => {
    const onsubmit = vi.fn(async () => {});
    render(LinearPostDialog, { branch: 'feat/a', onsubmit, onclose: vi.fn() });
    await fireEvent.input(screen.getByLabelText('Chave do time'), { target: { value: 'eng' } });
    await fireEvent.input(screen.getByLabelText(/Título/), { target: { value: 'Sessão A' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(onsubmit).toHaveBeenCalledWith({ kind: 'team', teamKey: 'ENG', title: 'Sessão A' });
  });
});
