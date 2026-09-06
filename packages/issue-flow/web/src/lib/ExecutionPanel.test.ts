import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  CAPABILITY: {
    configAgentWrite: 'config:agent:write',
    configRoutingWrite: 'config:routing:write',
    streamSessions: 'stream:sessions',
    terminalAttach: 'terminal:attach',
    worktrees: 'worktrees',
    conversation: 'agent:conversation',
    services: 'services',
    pullRequests: 'pr:ci',
  },
  api: {},
  canCall: vi.fn(() => false),
  hasCapability: vi.fn(() => false),
}));

import ExecutionPanel from './ExecutionPanel.svelte';
import { createExecutionSnapshot } from './execution-fixtures';

/**
 * The execution surface, end to end in a DOM.
 *
 * Defends **U2** (the header), **U4** (alerts), **U5** (the ARIA tablist),
 * **U6** (the "Estado agora" block), **U7** (context), **U9** (progress),
 * **U10** (Kanban), **U11** (history), **U12** (drawer), **U13** (metrics on
 * screen), **U14** (output) and **U21** (verification).
 */

const NOW = Date.parse('2026-09-06T10:05:00.000Z');

interface Handlers {
  onrefreshchange: ReturnType<typeof vi.fn>;
  ontabchange: ReturnType<typeof vi.fn>;
  onlogfilterchange: ReturnType<typeof vi.fn>;
  onhistoryfilterchange: ReturnType<typeof vi.fn>;
  onopendrawer: ReturnType<typeof vi.fn>;
  onclosedrawer: ReturnType<typeof vi.fn>;
  onopensettings: ReturnType<typeof vi.fn>;
}

function handlers(): Handlers {
  return {
    onrefreshchange: vi.fn(),
    ontabchange: vi.fn(),
    onlogfilterchange: vi.fn(),
    onhistoryfilterchange: vi.fn(),
    onopendrawer: vi.fn(),
    onclosedrawer: vi.fn(),
    onopensettings: vi.fn(),
  };
}

function renderPanel(props: Record<string, unknown> = {}): Handlers {
  const on = handlers();
  render(ExecutionPanel, {
    props: {
      snapshot: createExecutionSnapshot(),
      now: NOW,
      events: [],
      diagnostics: [],
      config: null,
      monitorVersion: '0.20.0',
      canEditPreferences: false,
      refreshSeconds: 5,
      activeTab: 'execution',
      logFilter: 'all',
      historyFilter: 'all',
      drawer: null,
      ...on,
      ...props,
    },
  });
  return on;
}

afterEach(cleanup);

describe('the execution header (U2)', () => {
  it('carries the issue, the branch, the monitor version, the status and both timers', () => {
    renderPanel();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('#42');
    expect(heading).toHaveTextContent('Absorver o painel');
    // `#N` links to the issue.
    expect(within(heading).getByRole('link', { name: '#42' })).toHaveAttribute(
      'href',
      'https://github.com/owner/repo/issues/42',
    );
    // The brand is never in the heading — it lives in the document title.
    expect(heading).not.toHaveTextContent('issue-flow');

    expect(screen.getByText(/feat\/42-painel ← main · criada pelo Issue Flow/)).toBeInTheDocument();
    // The chip is the **monitor's** version — the process that served these
    // assets — and it also appears in "Contexto" beside the run's.
    expect(screen.getByTitle('Versão do monitor que serve este painel')).toHaveTextContent(
      'v0.20.0',
    );
    expect(screen.getByText('executando')).toBeInTheDocument();
    // Elapsed and estimate, both live off the clock rather than the poll.
    expect(screen.getByTitle('Tempo decorrido')).toHaveTextContent('5min 00s');
    expect(screen.getByText(/~10min 00s restantes/)).toBeInTheDocument();
  });

  it('names an execution with no issue behind it instead of showing a bare dash', () => {
    renderPanel({
      snapshot: createExecutionSnapshot({
        issue: { number: null, url: null, title: null, description: null, labels: [], state: null },
      }),
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Execução sem issue vinculada',
    );
  });
});

describe('errors and warnings (U4)', () => {
  it('is announced politely and sits above the tabs', () => {
    renderPanel();

    const alerts = screen.getByText('Erros e avisos').closest('section');
    expect(alerts).not.toBeNull();
    expect(alerts).toHaveAttribute('aria-live', 'polite');
    expect(alerts).toHaveTextContent('1 erro(s) · 1 aviso(s)');
    expect(alerts).toHaveTextContent('Último erro:');

    // Above the tab list in document order — a failure must not be reachable
    // only through a tab.
    const tablist = screen.getByRole('tablist');
    expect(alerts?.compareDocumentPosition(tablist)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('renders the §32 escalation as its own line, in words', () => {
    renderPanel({
      snapshot: createExecutionSnapshot({
        agent: {
          lifecycle: 'awaiting-input',
          since: '2026-09-06T10:00:00.000Z',
          phase: 'execute',
          awaitingInputCount: 1,
          awaitingInputEscalatedAt: '2026-09-06T10:05:00.000Z',
          awaitingInputWaitedMs: 300_000,
          humanHold: null,
        },
      }),
    });

    expect(screen.getByText(/Ninguém respondeu ao agente/)).toBeInTheDocument();
    expect(screen.getByText(/não avança até alguém agir/)).toBeInTheDocument();
    // And the header says it too, as a badge distinct from "aguardando você".
    expect(screen.getByText('ninguém respondeu')).toBeInTheDocument();
  });

  it('shows nothing at all when there is nothing to say', () => {
    renderPanel({
      snapshot: createExecutionSnapshot({ logs: [], errors: [], warnings: [], lastError: null }),
    });
    expect(screen.queryByText('Erros e avisos')).not.toBeInTheDocument();
  });
});

describe('the tablist (U5)', () => {
  it('gives only the active tab a tabindex of 0', () => {
    renderPanel();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
    ]);
  });

  it('moves with the arrows and jumps with Home/End', async () => {
    const on = renderPanel();
    const tablist = screen.getByRole('tablist');

    await fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'ArrowRight' });
    expect(on.ontabchange).toHaveBeenLastCalledWith('kanban');

    await fireEvent.keyDown(tablist, { key: 'End' });
    expect(on.ontabchange).toHaveBeenLastCalledWith('history');

    await fireEvent.keyDown(tablist, { key: 'Home' });
    expect(on.ontabchange).toHaveBeenLastCalledWith('execution');

    // Wrapping, in both directions.
    await fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(on.ontabchange).toHaveBeenLastCalledWith('history');
  });

  it('leaves every other key alone', async () => {
    const on = renderPanel();
    await fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Tab' });
    expect(on.ontabchange).not.toHaveBeenCalled();
  });

  it('keeps every panel rendered, so an inactive tab is never stale', () => {
    renderPanel({ activeTab: 'kanban' });
    // The Kanban is visible…
    expect(screen.getByText('Backlog')).toBeVisible();
    // …and the execution panel is still in the document, only hidden.
    const executionPanel = document.getElementById('panel-execution');
    expect(executionPanel).not.toBeNull();
    expect(executionPanel).toHaveAttribute('hidden');
    expect(within(executionPanel as HTMLElement).getByText('Estado agora')).toBeInTheDocument();
  });
});

describe('"Estado agora" (U6)', () => {
  it('shows progress, what is running, resilience and the next steps', () => {
    renderPanel();
    const block = screen.getByText('Estado agora').closest('section') as HTMLElement;

    expect(within(block).getByText('40%')).toBeInTheDocument();
    // U13 on screen: the aggregate uses the same segments as core/metrics.ts.
    expect(
      within(block).getByText(
        'Fases 2/5 · Stories 1/3 · 12.4k in / 3.1k out · 88.0k cache · ~$0.42',
      ),
    ).toBeInTheDocument();

    expect(within(block).getByText('Executando agora')).toBeInTheDocument();
    expect(within(block).getByText('US-2')).toBeInTheDocument();
    expect(within(block).getByText('Edit')).toBeInTheDocument();

    expect(within(block).getByText('Resiliência')).toBeInTheDocument();
    expect(within(block).getByText('claude')).toBeInTheDocument();

    expect(within(block).getByText('Próximos passos:')).toBeInTheDocument();
    expect(within(block).getByText('Concluir US-2')).toBeInTheDocument();
  });

  it('says what happened rather than showing an empty grid when idle', () => {
    renderPanel({ snapshot: createExecutionSnapshot({ status: 'failed' }) });
    expect(screen.getByText('Execução falhou. Veja os erros acima.')).toBeInTheDocument();
  });
});

describe('"Contexto" (U7)', () => {
  it('carries the issue, the repository and the effective configuration', () => {
    renderPanel();
    const block = screen.getByText('Contexto').closest('section') as HTMLElement;

    expect(within(block).getByText('open')).toBeInTheDocument();
    expect(within(block).getByText('enhancement')).toBeInTheDocument();
    expect(within(block).getByText('Uma descrição da issue.')).toBeInTheDocument();

    expect(within(block).getByText('owner/repo')).toBeInTheDocument();
    expect(within(block).getByText('/tmp/repo')).toBeInTheDocument();

    expect(within(block).getByText('Harnesses e configuração efetiva')).toBeInTheDocument();
    expect(within(block).getByText('claude · configuração global')).toBeInTheDocument();
    expect(within(block).getByText('codex')).toBeInTheDocument();
    expect(
      within(block).getByText('cli, env, project, global'.replaceAll(', ', ' → ')),
    ).toBeInTheDocument();
    expect(within(block).getByText('v22.13.0', { exact: false })).toBeInTheDocument();
  });

  it('warns when the run and the monitor are different versions', () => {
    renderPanel({ monitorVersion: '0.21.0' });
    expect(screen.getByText(/servido por uma versão diferente/)).toBeInTheDocument();
  });

  it('says the state is read-only, and offers no editing without the capability (U8)', () => {
    renderPanel();
    expect(screen.getByText(/Este monitor não permite alterar preferências/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Editar as preferências/ }),
    ).not.toBeInTheDocument();
  });

  it('links to the one settings surface when the capability is announced (U8)', async () => {
    const on = renderPanel({ canEditPreferences: true });
    await fireEvent.click(screen.getByRole('button', { name: /Editar as preferências/ }));
    expect(on.onopensettings).toHaveBeenCalled();
  });
});

describe('"Andamento" (U9)', () => {
  it('lists phases and stories with their metrics, and opens the drawer', async () => {
    const on = renderPanel();
    const block = screen.getByText('Andamento').closest('section') as HTMLElement;

    expect(within(block).getByText('analyze')).toBeInTheDocument();
    expect(within(block).getByText('1min 00s · 1.0k in / 200 out · ~$0.05')).toBeInTheDocument();

    expect(within(block).getByText('Primeira story')).toBeInTheDocument();
    expect(within(block).getByText('depende de: US-1')).toBeInTheDocument();

    await fireEvent.click(within(block).getByText('analyze'));
    expect(on.onopendrawer).toHaveBeenCalledWith({ kind: 'phase', id: 'analyze' });

    await fireEvent.click(within(block).getByText('Segunda story'));
    expect(on.onopendrawer).toHaveBeenCalledWith({ kind: 'story', id: 'US-2' });
  });
});

describe('the Kanban (U10)', () => {
  it('groups the stories by status and makes every card a real button', async () => {
    const on = renderPanel({ activeTab: 'kanban' });
    const board = document.getElementById('panel-kanban') as HTMLElement;

    const cards = within(board).getAllByRole('button');
    expect(cards).toHaveLength(3);
    // A `<button>` gives Enter/Space and focus for free.
    for (const card of cards) {
      expect(card.tagName).toBe('BUTTON');
      // Only phrasing content inside — a `<p>` or `<div>` in a button is invalid.
      expect(card.querySelector('p, div')).toBeNull();
    }

    const done = within(board).getByText('Concluído').closest('section') as HTMLElement;
    expect(within(done).getByText('Primeira story')).toBeInTheDocument();

    const card = within(board).getByText('Segunda story').closest('button') as HTMLElement;
    expect(card).toHaveAttribute('data-story-id', 'US-2');
    card.focus();
    expect(document.activeElement).toBe(card);

    await fireEvent.click(card);
    expect(on.onopendrawer).toHaveBeenCalledWith({ kind: 'story', id: 'US-2' });
  });
});

describe('the journal (U11)', () => {
  it('renders the events it is given and reports the filter change', async () => {
    const on = renderPanel({
      activeTab: 'history',
      events: [
        {
          seq: 1,
          event: { type: 'phase:start', at: '2026-09-06T10:00:00.000Z', phase: 'execute' },
        },
        { seq: 2, event: { type: 'retry', at: '2026-09-06T10:01:00.000Z', attempt: 1 } },
      ],
    });

    const panel = document.getElementById('panel-history') as HTMLElement;
    expect(within(panel).getByText('Fase iniciada: execute')).toBeInTheDocument();
    expect(within(panel).getByText('Retry 1')).toBeInTheDocument();

    await fireEvent.change(within(panel).getByLabelText('Filtro do histórico'), {
      target: { value: 'resilience' },
    });
    expect(on.onhistoryfilterchange).toHaveBeenCalledWith('resilience');
  });
});

describe('the drawer (U12)', () => {
  it('opens on a phase with its timeline of attempts and its process output', () => {
    renderPanel({ drawer: { kind: 'phase', id: 'execute' } });

    const drawer = screen.getByRole('dialog');
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    expect(within(drawer).getByText('Fase · execute')).toBeInTheDocument();
    expect(within(drawer).getByText('Tentativas, revisões e correções')).toBeInTheDocument();
    expect(within(drawer).getByText(/execute · tentativa 1 · initial/)).toBeInTheDocument();
    expect(within(drawer).getByText('Saída do processo')).toBeInTheDocument();
    expect(within(drawer).getByText('1 linha(s) sanitizada(s)')).toBeInTheDocument();
    // The effective configuration of that phase comes along.
    expect(within(drawer).getByText('Harness efetivo')).toBeInTheDocument();
  });

  it('opens on a story with its criteria, dependencies and correlated diagnostics', () => {
    renderPanel({
      drawer: { kind: 'story', id: 'US-1' },
      diagnostics: [
        {
          timestamp: '2026-09-06T10:02:00.000Z',
          level: 'error',
          message: 'diagnóstico correlacionado',
          executionId: 'exec-1',
        },
        { timestamp: '2026-09-06T10:02:00.000Z', level: 'info', message: 'de outra execução' },
      ],
    });

    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText('US-1 · Primeira story')).toBeInTheDocument();
    expect(within(drawer).getByText('Critério A')).toBeInTheDocument();
    expect(within(drawer).getByText('Diagnóstico global persistente')).toBeInTheDocument();
    expect(within(drawer).getByText('1 registro(s) em ~/.issue-flow/logs')).toBeInTheDocument();
    expect(within(drawer).queryByText(/de outra execução/)).not.toBeInTheDocument();
  });

  it('closes on Escape and on the close button', async () => {
    const on = renderPanel({ drawer: { kind: 'story', id: 'US-1' } });

    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(on.onclosedrawer).toHaveBeenCalled();

    on.onclosedrawer.mockClear();
    await fireEvent.click(screen.getByRole('button', { name: 'Fechar detalhes' }));
    expect(on.onclosedrawer).toHaveBeenCalled();
  });

  it('closes itself when the story leaves the plan instead of showing a ghost', () => {
    const on = renderPanel({ drawer: { kind: 'story', id: 'US-999' } });
    expect(on.onclosedrawer).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('"Saída" (U14, U21)', () => {
  it('lists commits, pull requests and logs, and filters the logs by level', async () => {
    const on = renderPanel();
    const block = screen.getByText('Saída').closest('section') as HTMLElement;

    expect(within(block).getByText('abc1234')).toBeInTheDocument();
    expect(within(block).getByText('feat: primeiro commit')).toBeInTheDocument();
    // §50.3: the WebMux badge on the panel's PR list, one badge in the product.
    expect(within(block).getByText('PR #7')).toBeInTheDocument();
    expect(within(block).getByText('Um PR')).toBeInTheDocument();

    expect(within(block).getByText('tudo bem')).toBeInTheDocument();
    await fireEvent.change(within(block).getByLabelText('Filtro por nível de log'), {
      target: { value: 'error' },
    });
    expect(on.onlogfilterchange).toHaveBeenCalledWith('error');
  });

  it('shows only the requested level once the filter is applied', () => {
    renderPanel({ logFilter: 'error' });
    const block = screen.getByText('Saída').closest('section') as HTMLElement;
    expect(within(block).getByText('algo quebrou')).toBeInTheDocument();
    expect(within(block).queryByText('tudo bem')).not.toBeInTheDocument();
  });

  it('shows a PR whose state was never consulted as unknown, not as open', () => {
    renderPanel();
    expect(screen.getByTitle('estado não consultado')).toBeInTheDocument();
  });

  it('renders unverified as an honest verdict, never as a success (U21)', () => {
    renderPanel();
    const block = screen.getByText('Saída').closest('section') as HTMLElement;
    const verdict = within(block).getByText('não verificado');
    expect(verdict).toBeInTheDocument();
    expect(
      within(block).getByText(/o contrato rodou e não conseguiu concluir/i),
    ).toBeInTheDocument();
    // The `warn` role, not the `ok` role.
    expect(verdict.closest('p')).toHaveClass('if-verdict-warn');
  });

  it('says a passing verdict passed', () => {
    renderPanel({
      snapshot: createExecutionSnapshot({
        verification: { verdict: 'passed', level: 'contract', independence: 'independent' },
      }),
    });
    expect(screen.getByText('verificado').closest('p')).toHaveClass('if-verdict-ok');
  });

  it('distinguishes "no contract ran" from a verdict (U21)', () => {
    renderPanel({ snapshot: createExecutionSnapshot({ verification: null }) });
    expect(
      screen.getByText('Nenhum contrato de aceitação foi executado nesta execução.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('verificado')).not.toBeInTheDocument();
  });
});

describe('the refresh control (U16)', () => {
  it('offers the five options and reports the choice', async () => {
    const on = renderPanel();
    const select = screen.getByLabelText('Intervalo de atualização');
    expect(
      Array.from(select.querySelectorAll('option')).map((option) => option.textContent),
    ).toEqual(['3s', '5s', '10s', '30s', 'pausar']);

    await fireEvent.change(select, { target: { value: '0' } });
    expect(on.onrefreshchange).toHaveBeenCalledWith(0);
  });
});

describe('the footer', () => {
  it('says the execution is read-only', () => {
    renderPanel();
    expect(
      screen.getByText(/execução run-1 · atualizado .* · somente leitura/),
    ).toBeInTheDocument();
  });
});
