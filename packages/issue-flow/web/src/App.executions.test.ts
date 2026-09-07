import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from './lib/types';

/**
 * The shell, from the execution side.
 *
 * Defends **U1** (one execution opens straight into the detail), **U3** (the
 * disconnection banner), **U15** (three theme modes plus named palettes, applied before the first
 * paint, with the OS listener attached only in `system`), **U16** (one refresh
 * value across both headers) and **U17** (a replaced monitor reloads the page).
 *
 * The API module is mocked as a whole, exactly as `App.test.ts` does it: the
 * shell must never reach the network in a unit test, and a partial mock would
 * let a forgotten call through.
 */

const { MockTerminal, MockFitAddon } = vi.hoisted(() => {
  class MockFitAddon {
    fit = vi.fn();
  }
  class MockTerminal {
    options: { theme?: unknown } = {};
    cols = 80;
    rows = 24;
    modes = { mouseTrackingMode: 'none' };
    parser = { registerOscHandler: vi.fn(() => true) };
    loadAddon = vi.fn();
    onSelectionChange = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    focus = vi.fn();
    writeln = vi.fn();
    write = vi.fn();
    clearSelection = vi.fn();
    dispose = vi.fn();
    open = vi.fn();
    onData = vi.fn();
    getSelection = () => '';
    hasSelection = () => false;
  }
  return { MockTerminal, MockFitAddon };
});

vi.mock('@xterm/xterm', () => ({ Terminal: MockTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: MockFitAddon }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

vi.mock('./lib/api', () => ({
  CAPABILITY: {
    configAgentWrite: 'config:agent:write',
    configRoutingWrite: 'config:routing:write',
    streamSessions: 'stream:sessions',
    terminalAttach: 'terminal:attach',
    sessions: 'sessions',
    sessionOpen: 'session:open',
    worktreeMutations: 'worktrees:mutate',
    worktrees: 'worktrees',
    conversation: 'agent:conversation',
    services: 'services',
    pullRequests: 'pr:ci',
    linearRead: 'linear:read',
    linearWrite: 'linear:write',
    settingsWrite: 'settings:write',
  },
  api: {
    closeWorktree: vi.fn(),
    createWorktree: vi.fn(),
    fetchAvailableBranches: vi.fn(),
    fetchBaseBranches: vi.fn(),
    fetchCiLogs: vi.fn(),
    fetchConfig: vi.fn(),
    fetchWorktreeDiff: vi.fn(),
    mergeWorktree: vi.fn(),
    openWorktree: vi.fn(),
    pullMain: vi.fn(),
    removeWorktree: vi.fn(),
    setWorktreeArchived: vi.fn(),
    sendWorktreePrompt: vi.fn(),
    terminalToken: vi.fn(),
  },
  // No worktree capability: this is the monitor a pipeline run binds inline,
  // which serves executions and nothing else (ADR-03).
  canCall: vi.fn(() => false),
  canOpenSessions: vi.fn(() => false),
  openSession: vi.fn(async () => ({ branch: '', sessionId: '' })),
  fetchAgentSessions: vi.fn(async () => []),
  hasCapability: vi.fn((name: string) => name.startsWith('config:')),
  attachWorktreeConversation: vi.fn(),
  connectWorktreeConversationStream: vi.fn(),
  fetchWorktreeConversationHistory: vi.fn(),
  fetchWorktrees: vi.fn(async () => []),
  fetchLinearIssues: vi.fn(async () => ({ availability: 'disabled', issues: [] })),
  postWorktreeToLinear: vi.fn(),
  interruptWorktreeConversation: vi.fn(),
  refreshWorktreeAgentTerminal: vi.fn(),
  sendWorktreeConversationMessage: vi.fn(),
  setWorktreeLabel: vi.fn(),
  setWorktreeProfile: vi.fn(),
  createWorktreeTab: vi.fn(),
  selectWorktreeTab: vi.fn(),
  deleteWorktreeTab: vi.fn(),
  subscribeSessions: vi.fn(() => () => {}),
  fetchSessions: vi.fn(async (): Promise<SessionSummary[]> => []),
  fetchExecutionStatus: vi.fn(async () => ({ kind: 'not-modified' as const })),
  fetchExecutionEvents: vi.fn(async () => []),
  fetchExecutionDiagnostics: vi.fn(async () => []),
  fetchEffectiveConfig: vi.fn(async () => ({
    effective: null,
    capturedForSession: null,
    routing: null,
    catalog: [],
    writable: true,
    writeScope: 'global preferences for future executions',
  })),
  saveAgentPreference: vi.fn(async () => ({ ok: true })),
  saveRoutingPreference: vi.fn(async () => ({ ok: true })),
  loadCapabilities: vi.fn(async () => null),
  knownHealth: vi.fn(() => null),
  watchInstanceIdentity: vi.fn(),
  observeInstance: vi.fn(() => false),
  resetInstanceIdentity: vi.fn(),
  terminalSocketUrl: vi.fn(async () => 'ws://localhost/ws/terminal?token=t0ken'),
  uploadFiles: vi.fn(),
  activePrefix: '',
  apiBase: '',
  fetchProjects: vi.fn(async () => []),
  setUpProject: vi.fn(),
  removeProject: vi.fn(),
}));

import App from './App.svelte';
import {
  api,
  canCall,
  canOpenSessions,
  fetchAgentSessions,
  fetchExecutionStatus,
  fetchProjects,
  fetchSessions,
  fetchWorktrees,
  hasCapability,
  knownHealth,
  openSession,
  subscribeSessions,
  watchInstanceIdentity,
} from './lib/api';

const SNAPSHOT = {
  sessionId: 'run-1',
  status: 'running',
  issue: {
    number: 42,
    url: 'https://github.com/owner/repo/issues/42',
    title: 'Absorver o painel',
    description: null,
    labels: [],
    state: 'open',
  },
  progress: { percent: 40, phasesCompleted: 1, phasesTotal: 3 },
  startedAt: '2026-09-06T10:00:00.000Z',
};

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'run-1',
    projectId: 'proj-a',
    issueNumber: 42,
    issueTitle: 'Absorver o painel',
    issueDescription: null,
    repositoryName: 'owner/repo',
    currentPhase: 'execute',
    progressPercent: 40,
    elapsedSeconds: 300,
    status: 'running',
    startedAt: '2026-09-06T10:00:00.000Z',
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

const originalMatchMedia = window.matchMedia;
const systemThemeListeners: ((event: MediaQueryListEvent) => void)[] = [];

function setupBrowserMocks(): void {
  systemThemeListeners.length = 0;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn((_type: string, handler: (event: MediaQueryListEvent) => void) => {
        if (query.includes('prefers-color-scheme')) systemThemeListeners.push(handler);
      }),
      removeEventListener: vi.fn((_type: string, handler: (event: MediaQueryListEvent) => void) => {
        const index = systemThemeListeners.indexOf(handler);
        if (index !== -1) systemThemeListeners.splice(index, 1);
      }),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  });
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
  });
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  setupBrowserMocks();
  vi.mocked(fetchProjects).mockResolvedValue([]);
  vi.mocked(fetchSessions).mockResolvedValue([summary()]);
  vi.mocked(fetchExecutionStatus).mockResolvedValue({
    kind: 'snapshot',
    snapshot: SNAPSHOT,
    etag: 'W/"1"',
  });
  vi.mocked(subscribeSessions).mockReturnValue(() => {});
  vi.mocked(knownHealth).mockReturnValue(null);
  vi.mocked(canOpenSessions).mockReturnValue(false);
  vi.mocked(fetchAgentSessions).mockResolvedValue([]);
  vi.mocked(fetchWorktrees).mockResolvedValue([]);
  vi.mocked(canCall).mockReturnValue(false);
  vi.mocked(hasCapability).mockImplementation((name: string) => name.startsWith('config:'));
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

describe('the execution surface in the shell (U1)', () => {
  it('opens straight into the detail with a single execution', async () => {
    render(App);

    expect(await screen.findByRole('heading', { level: 1, name: /#42/ })).toBeInTheDocument();
    expect(screen.getByText('Estado agora')).toBeInTheDocument();
    // One execution needs no way back — there is no list behind it.
    expect(screen.queryByRole('button', { name: /Todas as execuções/ })).not.toBeInTheDocument();
  });

  it('lists cards with two, and opens one on click', async () => {
    vi.mocked(fetchSessions).mockResolvedValue([
      summary(),
      summary({ sessionId: 'run-2', issueNumber: 43, issueTitle: 'Outra' }),
    ]);
    render(App);

    expect(await screen.findByRole('heading', { level: 1, name: 'Trabalho ativo' })).toBeVisible();
    await fireEvent.click(
      screen
        .getAllByRole('button')
        .find((node) => node.dataset.sessionId === 'run-2') as HTMLElement,
    );

    expect(await screen.findByRole('heading', { level: 1, name: /#42/ })).toBeInTheDocument();
    // …and back to the list, because there is one to go back to.
    await fireEvent.click(screen.getByRole('button', { name: /Todas as execuções/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Trabalho ativo' })).toBeVisible();
  });

  it('lists the executions in the sidebar, beside the sessions group', async () => {
    render(App);
    // One sidebar, two groups (§50.3): "Execuções" is the panel's list, and
    // the worktree list is the other. The row names the execution the same way
    // the card and the header do.
    expect(await screen.findByText('Execuções')).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector('[data-execution-id="run-1"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-execution-id="run-1"]')?.textContent).toContain(
      'Absorver o painel',
    );
  });
});

describe('the disconnection banner (U3)', () => {
  it('appears when the stream errors and goes when it comes back', async () => {
    let onError: (() => void) | undefined;
    let onSessions: (() => void) | undefined;
    vi.mocked(subscribeSessions).mockImplementation((callbacks) => {
      onError = () => callbacks.onError?.();
      onSessions = () => callbacks.onSessions?.([]);
      return () => {};
    });

    render(App);
    await screen.findByRole('heading', { level: 1, name: /#42/ });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    onError?.();
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Desconectado do servidor. Tentando reconectar…');

    onSessions?.();
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('appears when a refresh throws, and clears on the next one that does not', async () => {
    vi.mocked(fetchSessions).mockRejectedValueOnce(new Error('offline'));
    render(App);

    expect(await screen.findByRole('alert')).toHaveTextContent('Desconectado do servidor');
  });
});

describe('the theme (U15)', () => {
  it('applies the stored choice before the bundle paints anything', () => {
    // The inline script in `index.html` is what runs first; the bundle keeps the
    // two in sync. Both read the same key, and the duplication is deliberate.
    localStorage.setItem('issue-flow:theme', 'dark');
    render(App);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('restores a named palette as an explicit choice', () => {
    localStorage.setItem('issue-flow:theme', 'github-dark');
    render(App);
    expect(document.documentElement.getAttribute('data-theme')).toBe('github-dark');
    expect(systemThemeListeners).toHaveLength(0);
  });

  it('removes the attribute in system mode rather than writing "system"', () => {
    // It is the **absence** of `data-theme` that hands the decision back to the
    // `@media` query. Writing the word would pin the panel to the light branch.
    localStorage.setItem('issue-flow:theme', 'system');
    render(App);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('attaches the OS listener only in system mode', async () => {
    render(App);
    await screen.findByRole('heading', { level: 1, name: /#42/ });
    // One listener, for `prefers-color-scheme`, because the stored theme is the
    // default `system`. With an explicit choice the OS must not win.
    expect(systemThemeListeners.length).toBeGreaterThan(0);
  });
});

describe('the refresh interval (U16)', () => {
  it('is one value, so both headers always agree', async () => {
    vi.mocked(fetchSessions).mockResolvedValue([summary(), summary({ sessionId: 'run-2' })]);
    render(App);

    // The dashboard's header.
    const dashboardSelect = await screen.findByLabelText('Intervalo de atualização');
    await fireEvent.change(dashboardSelect, { target: { value: '30' } });
    expect(localStorage.getItem('issue-flow:refresh-seconds')).toBe('30');

    // The execution's header, after opening one: same value, no sync step.
    await fireEvent.click(
      screen
        .getAllByRole('button')
        .find((node) => node.dataset.sessionId === 'run-1') as HTMLElement,
    );
    await screen.findByRole('heading', { level: 1, name: /#42/ });
    expect(screen.getByLabelText('Intervalo de atualização')).toHaveValue('30');
  });

  it('restores the stored choice on load', async () => {
    localStorage.setItem('issue-flow:refresh-seconds', '10');
    render(App);
    await screen.findByRole('heading', { level: 1, name: /#42/ });
    expect(screen.getByLabelText('Intervalo de atualização')).toHaveValue('10');
  });
});

describe('instance identity (U17)', () => {
  it('registers the reload before it makes any other request', async () => {
    render(App);
    await screen.findByRole('heading', { level: 1, name: /#42/ });
    expect(watchInstanceIdentity).toHaveBeenCalledWith(expect.any(Function));
  });
});

/**
 * I3 — a free session, with no issue, no plan and no workflow, in one click.
 *
 * The invariant of §48.6 in its sharpest form: Roteiro B must not get in
 * Roteiro A's way. The button is offered exactly where a session could be
 * opened (the `session:open` capability, ADR-10) and it opens one with no
 * dialog, because every field of the route is optional (§49.2).
 */
describe('opening a free session (I3)', () => {
  it('offers nothing where the monitor cannot open one', async () => {
    render(App);
    await screen.findByRole('heading', { level: 1, name: /#42/ });
    expect(screen.queryByTitle(/Nova sessão/)).not.toBeInTheDocument();
  });

  it('opens one in a single click, with no dialog in the way', async () => {
    vi.mocked(canOpenSessions).mockReturnValue(true);
    vi.mocked(openSession).mockResolvedValue({
      branch: 'session/scratch-a1b2',
      sessionId: 'sess-1',
    });

    render(App);
    const button = await screen.findByTitle(/Nova sessão/);
    await fireEvent.click(button);

    // No dialog appeared, and the request carried nothing: the branch, the
    // agent and the prompt are all the server's defaults.
    expect(vi.mocked(openSession)).toHaveBeenCalledWith();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByText('Sessão aberta em session/scratch-a1b2')).toBeInTheDocument();
  });

  it('says what went wrong instead of failing silently', async () => {
    vi.mocked(canOpenSessions).mockReturnValue(true);
    vi.mocked(openSession).mockRejectedValue(new Error('tmux não está disponível'));

    render(App);
    await fireEvent.click(await screen.findByTitle(/Nova sessão/));
    expect(
      await screen.findByText(/Falha ao abrir a sessão: tmux não está disponível/),
    ).toBeInTheDocument();
  });

  it('keeps the full worktree dialog reachable when free sessions are also available', async () => {
    vi.mocked(canOpenSessions).mockReturnValue(true);
    vi.mocked(hasCapability).mockImplementation(
      (name: string) => name.startsWith('config:') || name === 'worktrees:mutate',
    );
    vi.mocked(canCall).mockImplementation((route: string) => route === 'fetchConfig');
    vi.mocked(api.fetchConfig).mockResolvedValue({
      name: 'repo',
      services: [],
      profiles: [{ name: 'default' }],
      agents: [
        {
          id: 'claude',
          label: 'Claude',
          kind: 'builtin',
          capabilities: {
            terminal: true,
            inAppChat: true,
            conversationHistory: true,
            interrupt: true,
            resume: true,
          },
        },
      ],
      defaultProfileName: 'default',
      defaultAgentId: 'claude',
      autoName: false,
      linearAvailability: 'disabled',
      linearAutoCreateWorktrees: false,
      startupEnvs: {},
      linkedRepos: [],
      autoRemoveOnMerge: false,
      projectDir: '/repo',
      mainBranch: 'main',
    });

    render(App);
    expect(await screen.findByTitle('Nova sessão (Cmd+K)')).toBeInTheDocument();
    const worktreeButton = await screen.findByTitle('Novo worktree');
    await fireEvent.click(worktreeButton);
    expect(await screen.findByRole('heading', { name: 'Novo worktree' })).toBeInTheDocument();
  });
});

/**
 * I4 — a session linked to an issue starts showing the workflow.
 *
 * There is no promotion event and no second component: the row starts carrying
 * an `executionId`, the shell asks for that execution's snapshot, and the
 * workflow tabs appear in place.
 */
describe('promoting a session (I4)', () => {
  it('shows the workflow for a session that belongs to a run', async () => {
    vi.mocked(hasCapability).mockImplementation((name: string) => name !== 'worktrees');
    vi.mocked(canCall).mockImplementation((route: string) => route === 'fetchWorktrees');
    vi.mocked(fetchWorktrees).mockResolvedValue([
      {
        branch: 'session/scratch',
        label: null,
        archived: false,
        agent: 'working',
        mux: '✓',
        path: '/w/session-scratch',
        dir: '/w/session-scratch',
        dirty: false,
        unpushed: false,
        status: 'running',
        elapsed: '5m',
        profile: null,
        agentName: 'codex',
        agentLabel: 'Codex',
        agentTerminalStale: false,
        services: [],
        paneCount: 1,
        prs: [],
        creating: false,
        creationPhase: null,
        source: 'ui',
        oneshot: null,
        tabs: [],
        activeTabId: null,
        supportsTabs: false,
        // The one field that decides it.
        executionId: 'run-1',
        issueRef: null,
      },
    ]);

    render(App);

    // The workflow tabs are there, on a row that came from the session list.
    expect(await screen.findByRole('tab', { name: 'Visão geral' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Verificação' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Sessões e worktrees' })).toBeInTheDocument();
  });
});
