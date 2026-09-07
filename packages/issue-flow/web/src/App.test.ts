import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentsUiWorktreeConversationResponse,
  AppConfig,
  SessionSummary,
  WorktreeInfo,
} from './lib/types';

/**
 * PORT of `frontend/src/App.test.ts` @ d8c9d5f — 26 cases.
 *
 * Six upstream cases were Linear (the panel's two states, the ticket option's
 * two, and the two "post conversation to Linear" flows). During the initial
 * frontend port they were **replaced** by six cases covering the capability
 * gate, the optional
 * issue link that keeps a free session one click away (ADR-16/ADR-17), the
 * authenticated session-keyed terminal (ADR-10), and the push channel that
 * replaced polling (§35). The restored Linear surface has its own focused
 * component/API cases below and in `LinearComponents.test.ts`.
 */

const { MockFitAddon, MockTerminal, MockWebSocket } = vi.hoisted(() => {
  class MockFitAddon {
    static instances: MockFitAddon[] = [];

    fit = vi.fn();

    constructor() {
      MockFitAddon.instances.push(this);
    }
  }

  class MockTerminal {
    static instances: MockTerminal[] = [];

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

    constructor(_options: unknown) {
      MockTerminal.instances.push(this);
    }

    open(container: HTMLElement): void {
      const xterm = document.createElement('div');
      xterm.className = 'xterm';
      const viewport = document.createElement('div');
      viewport.className = 'xterm-viewport';
      xterm.appendChild(viewport);
      container.appendChild(xterm);
    }

    onData(_handler: (data: string) => void): void {}

    getSelection(): string {
      return '';
    }

    hasSelection(): boolean {
      return false;
    }
  }

  class MockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readonly url: string;
    readyState = MockWebSocket.CONNECTING;
    sent: string[] = [];
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(url: string | URL) {
      this.url = String(url);
      MockWebSocket.instances.push(this);
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
    }
  }

  return { MockFitAddon, MockTerminal, MockWebSocket };
});

vi.mock('@xterm/xterm', () => ({ Terminal: MockTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: MockFitAddon }));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class MockWebLinksAddon {},
}));

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
  canCall: vi.fn(() => true),
  hasCapability: vi.fn(() => true),
  canOpenSessions: vi.fn(() => false),
  openSession: vi.fn(async () => ({ branch: '', sessionId: '' })),
  fetchAgentSessions: vi.fn(async () => []),
  attachWorktreeConversation: vi.fn(),
  connectWorktreeConversationStream: vi.fn(),
  fetchWorktreeConversationHistory: vi.fn(),
  fetchWorktrees: vi.fn(),
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
  subscribeSessions: vi.fn(),
  fetchSessions: vi.fn(async (): Promise<SessionSummary[]> => []),
  // The execution surface (Fase 8C).
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
  terminalSocketUrl: vi.fn(
    async (target: { sessionId?: string | null; branch?: string | null }) =>
      `ws://localhost/ws/terminal?token=t0ken&session=${target.sessionId ?? ''}&branch=${
        target.branch ?? ''
      }`,
  ),
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
  attachWorktreeConversation,
  canCall,
  connectWorktreeConversationStream,
  createWorktreeTab,
  deleteWorktreeTab,
  fetchWorktrees,
  hasCapability,
  refreshWorktreeAgentTerminal,
  selectWorktreeTab,
  setWorktreeLabel,
  setWorktreeProfile,
  subscribeSessions,
} from './lib/api';
import { createWorktree as createBaseWorktree } from './lib/test-fixtures';
import { LAST_SELECTED_WORKTREE_STORAGE_KEY, WEB_CHAT_UI_STORAGE_KEY } from './lib/utils';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

const originalMatchMedia = window.matchMedia;
const originalDialogShowModal = HTMLDialogElement.prototype.showModal;
const originalDialogClose = HTMLDialogElement.prototype.close;
const originalWebSocket = globalThis.WebSocket;
const originalResizeObserver = globalThis.ResizeObserver;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    name: 'repo',
    services: [],
    startupEnvs: {},
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
      {
        id: 'codex',
        label: 'Codex',
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
    linkedRepos: [],
    autoRemoveOnMerge: false,
    projectDir: '/repo',
    mainBranch: 'main',
    ...overrides,
  };
}

function createWorktree(branch: string, overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return createBaseWorktree(branch, { elapsed: '1m', ...overrides });
}

function createConversationResponse(worktree: WorktreeInfo): AgentsUiWorktreeConversationResponse {
  return {
    worktree: {
      branch: worktree.branch,
      path: worktree.path,
      archived: worktree.archived,
      profile: worktree.profile,
      agentName: worktree.agentName,
      agentLabel: worktree.agentLabel,
      agentTerminalStale: worktree.agentTerminalStale,
      mux: worktree.mux === '✓',
      status: worktree.status,
      dirty: worktree.dirty,
      unpushed: worktree.unpushed,
      services: worktree.services,
      prs: worktree.prs,
      creating: worktree.creating,
      creationPhase: worktree.creationPhase,
      conversation: null,
    },
    conversation: {
      provider: worktree.agentName === 'codex' ? 'codexAppServer' : 'claudeCode',
      conversationId: worktree.agentName === 'codex' ? 'thread-1' : 'session-1',
      cwd: worktree.path,
      running: false,
      activeTurnId: null,
      messages: [],
    },
  };
}

function setupBrowserMocks(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: MockWebSocket,
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: MockResizeObserver,
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
  });
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement): void {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement): void {
    this.open = false;
  });
}

function restoreBrowserMocks(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: originalWebSocket,
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: originalResizeObserver,
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: originalRequestAnimationFrame,
  });
  HTMLDialogElement.prototype.showModal = originalDialogShowModal;
  HTMLDialogElement.prototype.close = originalDialogClose;
}

async function openCreateDialogAndSubmit(branch: string): Promise<void> {
  await fireEvent.click(screen.getByTitle('Novo worktree (Cmd+K)'));
  await screen.findByRole('heading', { name: 'Novo worktree' });
  await fireEvent.input(screen.getByLabelText(/Nome da branch/i), {
    target: { value: branch },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
}

async function openCreateDialogWithBaseAndSubmit(
  branch: string,
  baseBranch: string,
): Promise<void> {
  await fireEvent.click(screen.getByTitle('Novo worktree (Cmd+K)'));
  await screen.findByRole('heading', { name: 'Novo worktree' });
  await fireEvent.input(screen.getByLabelText(/Nome da branch/i), {
    target: { value: branch },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Branch base' }));
  await fireEvent.click(await screen.findByRole('button', { name: baseBranch }));
  await fireEvent.click(screen.getByRole('button', { name: 'Criar' }));
}

describe('App create selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockTerminal.instances = [];
    MockFitAddon.instances = [];
    MockWebSocket.instances = [];
    cleanup();
    localStorage.clear();
    setupBrowserMocks();

    vi.mocked(canCall).mockReturnValue(true);
    vi.mocked(hasCapability).mockReturnValue(true);
    vi.mocked(api.fetchConfig).mockResolvedValue(createConfig());
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.fetchAvailableBranches).mockResolvedValue({ branches: [] });
    vi.mocked(api.fetchBaseBranches).mockResolvedValue({ branches: [] });
    vi.mocked(api.fetchWorktreeDiff).mockResolvedValue({
      uncommitted: '',
      uncommittedTruncated: false,
      gitStatus: '',
      unpushedCommits: [],
    });
    vi.mocked(subscribeSessions).mockReturnValue(() => {});
    vi.mocked(api.openWorktree).mockResolvedValue({ ok: true });
    vi.mocked(api.closeWorktree).mockResolvedValue({ ok: true });
    vi.mocked(api.removeWorktree).mockResolvedValue({ ok: true });
    vi.mocked(api.setWorktreeArchived).mockResolvedValue({ ok: true, archived: true });
    vi.mocked(api.mergeWorktree).mockResolvedValue({ ok: true });
    vi.mocked(api.pullMain).mockResolvedValue({ status: 'updated' });
    vi.mocked(api.fetchCiLogs).mockResolvedValue({ logs: '' });
    vi.mocked(api.sendWorktreePrompt).mockResolvedValue({ ok: true });
    vi.mocked(connectWorktreeConversationStream).mockReturnValue(() => {});
    vi.mocked(refreshWorktreeAgentTerminal).mockResolvedValue(undefined);
    vi.mocked(setWorktreeLabel).mockResolvedValue(null);
    vi.mocked(setWorktreeProfile).mockResolvedValue({ profile: 'full', restarted: true });
    vi.mocked(createWorktreeTab).mockResolvedValue({
      tabId: 'created-fork',
      sessionId: 'created-fork',
      kind: 'fork',
      label: 'Fork 1',
      seq: 1,
      createdAt: '2026-09-06T12:00:00.000Z',
    });
    vi.mocked(selectWorktreeTab).mockResolvedValue(undefined);
    vi.mocked(deleteWorktreeTab).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    restoreBrowserMocks();
  });

  it('keeps the current selection when a new worktree is created from an existing selection', async () => {
    const existingWorktree = createWorktree('main');
    const creatingWorktree = createWorktree('feature/new', {
      creating: true,
      creationPhase: 'creating_worktree',
    });
    const newWorktree = createWorktree('feature/new');
    const createResult = deferred<{ primaryBranch: string; branches: string[] }>();

    vi.mocked(fetchWorktrees)
      .mockResolvedValueOnce([existingWorktree])
      .mockResolvedValueOnce([existingWorktree, creatingWorktree])
      .mockResolvedValueOnce([existingWorktree, newWorktree])
      .mockResolvedValue([existingWorktree, newWorktree]);
    vi.mocked(api.createWorktree).mockReturnValueOnce(createResult.promise);

    render(App);

    await screen.findByTitle('main');

    await openCreateDialogAndSubmit('feature/new');

    await waitFor(() => {
      expect(fetchWorktrees).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByRole('button', { name: /^feature\/new\b/i })).toBeInTheDocument();
    expect(screen.getByTitle('main')).toBeInTheDocument();
    expect(screen.queryByTitle('feature/new')).not.toBeInTheDocument();

    createResult.resolve({ primaryBranch: 'feature/new', branches: ['feature/new'] });

    await waitFor(() => {
      expect(fetchWorktrees).toHaveBeenCalledTimes(3);
    });
    expect(screen.getByTitle('main')).toBeInTheDocument();
    expect(screen.queryByTitle('feature/new')).not.toBeInTheDocument();
  });

  it('selects the new worktree when nothing was selected before creation', async () => {
    const creatingWorktree = createWorktree('feature/new', {
      creating: true,
      creationPhase: 'creating_worktree',
    });
    const newWorktree = createWorktree('feature/new');
    const createResult = deferred<{ primaryBranch: string; branches: string[] }>();

    vi.mocked(fetchWorktrees)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([creatingWorktree])
      .mockResolvedValueOnce([newWorktree])
      .mockResolvedValue([newWorktree]);
    vi.mocked(api.createWorktree).mockReturnValueOnce(createResult.promise);

    render(App);

    await screen.findByText('Selecione um worktree');

    await openCreateDialogAndSubmit('feature/new');
    createResult.resolve({ primaryBranch: 'feature/new', branches: ['feature/new'] });

    await waitFor(() => {
      expect(fetchWorktrees).toHaveBeenCalledTimes(3);
    });
    expect(screen.getByTitle('feature/new')).toBeInTheDocument();
  });

  it('shows an error toast when worktree creation fails', async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.createWorktree).mockRejectedValueOnce(new Error('a branch já existe'));

    render(App);

    await screen.findByText('Selecione um worktree');
    await openCreateDialogAndSubmit('feature/new');

    const toast = await screen.findByRole('alert');
    expect(toast).toHaveTextContent('Falha ao criar: a branch já existe');
  });

  it('dismisses a toast from its close button', async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.createWorktree).mockRejectedValueOnce(new Error('boom'));

    render(App);

    await screen.findByText('Selecione um worktree');
    await openCreateDialogAndSubmit('feature/new');

    const toast = await screen.findByRole('alert');
    await fireEvent.click(within(toast).getByRole('button', { name: 'Dispensar aviso' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a success toast when pulling main succeeds', async () => {
    vi.mocked(api.fetchConfig).mockResolvedValue(
      createConfig({
        projectDir: '/repo',
        mainBranch: 'main',
      }),
    );
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.pullMain).mockResolvedValueOnce({ status: 'updated' });

    render(App);

    await screen.findByText('Selecione um worktree');
    await screen.findByText('main');
    await fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    await fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Atualizar' }),
    );

    expect(api.pullMain).toHaveBeenCalledWith({ body: {} });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '"main" atualizada a partir do remoto',
    );
  });

  it('selects the primary paired worktree when several agents are created without a prior selection', async () => {
    const creatingClaude = createWorktree('claude-feature/new', {
      creating: true,
      creationPhase: 'creating_worktree',
    });
    const creatingCodex = createWorktree('codex-feature/new', {
      creating: true,
      creationPhase: 'creating_worktree',
    });
    const createdClaude = createWorktree('claude-feature/new');
    const createdCodex = createWorktree('codex-feature/new');
    const createResult = deferred<{ primaryBranch: string; branches: string[] }>();

    vi.mocked(fetchWorktrees)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([creatingClaude, creatingCodex])
      .mockResolvedValueOnce([createdClaude, createdCodex])
      .mockResolvedValue([createdClaude, createdCodex]);
    vi.mocked(api.createWorktree).mockReturnValueOnce(createResult.promise);

    render(App);

    await screen.findByText('Selecione um worktree');

    await fireEvent.click(screen.getByTitle('Novo worktree (Cmd+K)'));
    await screen.findByRole('heading', { name: 'Novo worktree' });
    await fireEvent.click(
      screen.getByRole('switch', { name: /permitir selecionar vários agentes/i }),
    );
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Codex' }));
    await fireEvent.input(screen.getByLabelText(/Nome da branch/i), {
      target: { value: 'feature/new' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Criar' }));

    createResult.resolve({
      primaryBranch: 'claude-feature/new',
      branches: ['claude-feature/new', 'codex-feature/new'],
    });

    await waitFor(() => {
      expect(fetchWorktrees).toHaveBeenCalledTimes(3);
    });
    expect(screen.getByTitle('claude-feature/new')).toBeInTheDocument();
  });

  it('hides archived worktrees until the archived toggle is enabled', async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([
      createWorktree('feature/active'),
      createWorktree('feature/archived', { archived: true }),
    ]);

    render(App);

    await screen.findByRole('button', { name: /^feature\/active\b/i });
    expect(screen.queryByRole('button', { name: /feature\/archived/i })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('switch', { name: /mostrar worktrees arquivados/i }));

    expect(
      await screen.findByRole('button', { name: /^feature\/archived\b/i }),
    ).toBeInTheDocument();
  });

  it('keeps the current selection while filtering the worktree list', async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([
      createWorktree('main'),
      createWorktree('feature/alpha'),
      createWorktree('feature/beta'),
    ]);

    render(App);

    const searchInput = await screen.findByRole('searchbox', { name: /buscar worktrees/i });
    await screen.findByTitle('main');

    await fireEvent.focus(searchInput);
    await fireEvent.input(searchInput, { target: { value: 'feature' } });

    expect(screen.getByTitle('main')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^main\b/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^feature\/alpha\b/i })).toBeInTheDocument();
  });

  it('clears the worktree search from the trailing clear button', async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([
      createWorktree('feature/alpha'),
      createWorktree('feature/beta'),
    ]);

    render(App);

    const searchInput = await screen.findByRole('searchbox', { name: /buscar worktrees/i });
    await fireEvent.input(searchInput, { target: { value: 'alpha' } });
    expect(searchInput).toHaveValue('alpha');

    await fireEvent.click(screen.getByRole('button', { name: /limpar a busca/i }));

    expect(searchInput).toHaveValue('');
  });

  it('archives the selected worktree through the API', async () => {
    vi.mocked(fetchWorktrees)
      .mockResolvedValueOnce([createWorktree('feature/active')])
      .mockResolvedValueOnce([createWorktree('feature/active', { archived: true })])
      .mockResolvedValue([createWorktree('feature/active', { archived: true })]);

    render(App);

    await screen.findByTitle('feature/active');
    await fireEvent.click(screen.getByRole('button', { name: 'Arquivar' }));

    await waitFor(() => {
      expect(api.setWorktreeArchived).toHaveBeenCalledWith({
        params: { name: 'feature/active' },
        body: { archived: true },
      });
    });
  });

  it('reconnects the visible terminal after refreshing a stale terminal', async () => {
    localStorage.setItem(LAST_SELECTED_WORKTREE_STORAGE_KEY, 'feature/active');
    const staleWorktree = createWorktree('feature/active', {
      mux: '✓',
      agentName: 'codex',
      agentLabel: 'Codex',
      agentTerminalStale: true,
    });
    const refreshedWorktree = createWorktree('feature/active', {
      mux: '✓',
      agentName: 'codex',
      agentLabel: 'Codex',
      agentTerminalStale: false,
    });

    vi.mocked(fetchWorktrees)
      .mockResolvedValueOnce([staleWorktree])
      .mockResolvedValueOnce([refreshedWorktree])
      .mockResolvedValue([refreshedWorktree]);

    render(App);

    await screen.findByText('Terminal desatualizado');
    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Recarregar' }));

    await waitFor(() => {
      expect(refreshWorktreeAgentTerminal).toHaveBeenCalledWith('feature/active');
    });
    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2);
    });
    expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('opens the terminal socket with a token and the selected session', async () => {
    // Replaced an upstream Linear case during the initial frontend port: the socket is a remote shell
    // and never opens unauthenticated (ADR-10), and it is keyed by session
    // rather than branch (§48.3).
    localStorage.setItem(LAST_SELECTED_WORKTREE_STORAGE_KEY, 'feature/live');
    vi.mocked(fetchWorktrees).mockResolvedValue([
      createWorktree('feature/live', {
        mux: '✓',
        agentName: 'codex',
        agentLabel: 'Codex',
        activeTabId: 'tab-1',
        tabs: [
          {
            tabId: 'tab-1',
            kind: 'root',
            label: 'root',
            seq: 0,
            sessionId: 'session-42',
            createdAt: '2026-04-15T12:00:00.000Z',
          },
        ],
      }),
    ]);

    render(App);

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });
    expect(MockWebSocket.instances[0].url).toContain('token=t0ken');
    expect(MockWebSocket.instances[0].url).toContain('session=session-42');
  });

  it('refreshes on a pushed frame rather than waiting for an interval', async () => {
    // Replaced an upstream Linear case during the initial frontend port. §35 puts a hard 250 ms p95
    // ceiling on output→screen; the interval is a safety net, not the path.
    let pushSessions: (() => void) | undefined;
    vi.mocked(subscribeSessions).mockImplementation((callbacks) => {
      pushSessions = () => callbacks.onSessions?.([]);
      return () => {};
    });
    vi.mocked(fetchWorktrees).mockResolvedValue([createWorktree('feature/pushed')]);

    render(App);

    await screen.findByTitle('feature/pushed');
    const callsBefore = vi.mocked(fetchWorktrees).mock.calls.length;

    pushSessions?.();

    await waitFor(() => {
      expect(vi.mocked(fetchWorktrees).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('edits the selected worktree label from the header', async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([createWorktree('feature/active')]);
    vi.mocked(setWorktreeLabel).mockResolvedValue('Ranking da busca');

    render(App);

    await screen.findByTitle('feature/active');
    await fireEvent.click(screen.getByRole('button', { name: 'Editar o rótulo do workspace' }));
    await fireEvent.input(screen.getByLabelText('Rótulo'), {
      target: { value: 'Ranking da busca' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(setWorktreeLabel).toHaveBeenCalledWith('feature/active', 'Ranking da busca');
    });
    expect(screen.getAllByText('Ranking da busca').length).toBeGreaterThan(0);
  });

  it('switches a worktree to another profile from the sidebar row menu', async () => {
    vi.mocked(api.fetchConfig).mockResolvedValue(
      createConfig({
        profiles: [{ name: 'slim' }, { name: 'full' }],
        defaultProfileName: 'slim',
      }),
    );
    vi.mocked(fetchWorktrees).mockResolvedValue([
      createWorktree('feature/active', { profile: 'slim', mux: '✓' }),
    ]);

    render(App);

    await screen.findByTitle('feature/active');
    await fireEvent.click(screen.getByRole('button', { name: /ações de feature\/active/i }));
    await fireEvent.click(screen.getByRole('button', { name: 'Trocar profile…' }));
    await fireEvent.click(screen.getByRole('radio', { name: 'full' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Trocar' }));

    await waitFor(() => {
      expect(setWorktreeProfile).toHaveBeenCalledWith('feature/active', 'full');
    });
  });

  it('says so honestly when the monitor does not serve worktrees', async () => {
    // Replaced an upstream Linear-panel case during the initial frontend port. A monitor bound inline
    // by a pipeline run has no worktree surface; an empty list would read as a
    // failure, so the panel says which monitor this is.
    vi.mocked(canCall).mockReturnValue(false);
    vi.mocked(hasCapability).mockReturnValue(false);

    render(App);

    expect(
      await screen.findByText(/Worktrees, sessões e terminal aparecem quando o servidor/i),
    ).toBeInTheDocument();
    expect(fetchWorktrees).not.toHaveBeenCalled();
  });

  it('offers no worktree creation on a monitor that does not serve them', async () => {
    // Replaced an upstream Linear-panel case during the initial frontend port.
    vi.mocked(canCall).mockReturnValue(false);
    vi.mocked(hasCapability).mockReturnValue(false);

    render(App);

    await screen.findByText(/Worktrees, sessões e terminal aparecem quando o servidor/i);
    expect(screen.queryByTitle('Novo worktree (Cmd+K)')).not.toBeInTheDocument();
  });

  it('shows the web chat UI on desktop when the local setting is enabled', async () => {
    const worktree = createWorktree('feature/chat', {
      mux: '✓',
      agentName: 'claude',
      agentLabel: 'Claude',
    });
    localStorage.setItem(WEB_CHAT_UI_STORAGE_KEY, 'true');
    vi.mocked(fetchWorktrees).mockResolvedValue([worktree]);
    vi.mocked(attachWorktreeConversation).mockResolvedValue(createConversationResponse(worktree));

    render(App);

    expect(await screen.findByRole('textbox', { name: 'Mensagem' })).toBeInTheDocument();
    expect(attachWorktreeConversation).toHaveBeenCalledWith('feature/chat');
  });

  it('does not show the stale terminal banner in the web chat UI', async () => {
    const worktree = createWorktree('feature/chat-stale-terminal', {
      mux: '✓',
      agentName: 'codex',
      agentLabel: 'Codex',
      agentTerminalStale: true,
    });
    localStorage.setItem(WEB_CHAT_UI_STORAGE_KEY, 'true');
    vi.mocked(fetchWorktrees).mockResolvedValue([worktree]);
    vi.mocked(attachWorktreeConversation).mockResolvedValue(createConversationResponse(worktree));

    render(App);

    expect(await screen.findByRole('textbox', { name: 'Mensagem' })).toBeInTheDocument();
    expect(screen.queryByText('Terminal desatualizado')).not.toBeInTheDocument();
  });

  it('creates, selects and confirms deletion of terminal tabs only when supported', async () => {
    const root = {
      tabId: 'session-root',
      sessionId: 'session-root',
      kind: 'root' as const,
      label: 'Root',
      seq: null,
      paneId: '%1',
      createdAt: '2026-09-06T12:00:00.000Z',
    };
    const fork = {
      tabId: 'session-fork',
      sessionId: 'session-fork',
      kind: 'fork' as const,
      label: 'Fork 1',
      seq: 1,
      paneId: '%2',
      createdAt: '2026-09-06T12:01:00.000Z',
    };
    vi.mocked(fetchWorktrees).mockResolvedValue([
      createWorktree('feature/tabs', {
        mux: '✓',
        agentName: 'claude',
        agentLabel: 'Claude',
        supportsTabs: true,
        tabs: [root, fork],
        activeTabId: root.tabId,
      }),
    ]);

    render(App);

    await fireEvent.click(await screen.findByRole('button', { name: 'Nova sessão derivada' }));
    await waitFor(() => expect(createWorktreeTab).toHaveBeenCalledWith('feature/tabs'));

    await fireEvent.click(screen.getByRole('tab', { name: 'Fork 1' }));
    await waitFor(() =>
      expect(selectWorktreeTab).toHaveBeenCalledWith('feature/tabs', 'session-fork'),
    );

    const closeFork = screen.getByRole('button', { name: 'Fechar Fork 1' });
    await waitFor(() => expect(closeFork).toBeEnabled());
    await fireEvent.click(closeFork);
    expect(deleteWorktreeTab).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Apenas esta sessão derivada');
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Encerrar sessão' }));
    await waitFor(() =>
      expect(deleteWorktreeTab).toHaveBeenCalledWith('feature/tabs', 'session-fork'),
    );
  });

  it('hides tab controls when the selected runtime does not support forks', async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([
      createWorktree('feature/sandbox', {
        mux: '✓',
        agentName: 'claude',
        supportsTabs: false,
        tabs: [
          {
            tabId: 'session-root',
            sessionId: 'session-root',
            kind: 'root',
            label: 'Root',
            seq: null,
            createdAt: '2026-09-06T12:00:00.000Z',
          },
        ],
        activeTabId: 'session-root',
      }),
    ]);

    render(App);

    await screen.findByTitle('feature/sandbox');
    expect(screen.queryByRole('button', { name: 'Nova sessão derivada' })).not.toBeInTheDocument();
  });

  it('keeps the issue link optional so a free session is one click away', async () => {
    // Replaced an upstream Linear-ticket case during the initial frontend port. ADR-16/ADR-17: nothing
    // in this dialog may become required, or the free-session route (Roteiro A)
    // is blocked by the workflow route (Roteiro B).
    vi.mocked(fetchWorktrees).mockResolvedValue([]);

    render(App);

    await fireEvent.click(screen.getByTitle('Novo worktree (Cmd+K)'));
    await screen.findByRole('heading', { name: 'Novo worktree' });

    expect(screen.getByLabelText(/Issue vinculada/i)).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Criar' })).not.toBeDisabled();
  });

  it('submits the linked issue when one is provided', async () => {
    // Replaced an upstream Linear-ticket case during the initial frontend port.
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.createWorktree).mockResolvedValue({
      primaryBranch: 'feature/linked',
      branches: ['feature/linked'],
    });

    render(App);

    await fireEvent.click(screen.getByTitle('Novo worktree (Cmd+K)'));
    await screen.findByRole('heading', { name: 'Novo worktree' });

    await fireEvent.input(screen.getByLabelText(/Nome da branch/i), {
      target: { value: 'feature/linked' },
    });
    await fireEvent.input(screen.getByLabelText(/Issue vinculada/i), {
      target: { value: '142' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Criar' }));

    await waitFor(() => {
      expect(api.createWorktree).toHaveBeenCalledWith({
        body: {
          mode: 'new',
          branch: 'feature/linked',
          profile: 'default',
          agents: ['claude'],
          issueRef: '142',
        },
      });
    });
  });

  it('shows prefixed branch previews when multiple agents are selected', async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([]);

    render(App);

    await fireEvent.click(screen.getByTitle('Novo worktree (Cmd+K)'));
    await screen.findByRole('heading', { name: 'Novo worktree' });

    await fireEvent.click(
      screen.getByRole('switch', { name: /permitir selecionar vários agentes/i }),
    );
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Codex' }));
    await fireEvent.input(screen.getByLabelText(/Nome da branch/i), {
      target: { value: 'feature/new' },
    });

    expect(screen.getByText('claude-feature/new')).toBeInTheDocument();
    expect(screen.getByText('codex-feature/new')).toBeInTheDocument();
  });

  it('submits multi-agent worktree creation when multiple agents are selected', async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.createWorktree).mockResolvedValue({
      primaryBranch: 'claude-feature/new',
      branches: ['claude-feature/new', 'codex-feature/new'],
    });

    render(App);

    await fireEvent.click(screen.getByTitle('Novo worktree (Cmd+K)'));
    await screen.findByRole('heading', { name: 'Novo worktree' });

    await fireEvent.click(
      screen.getByRole('switch', { name: /permitir selecionar vários agentes/i }),
    );
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Codex' }));
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Usar uma branch existente' }),
      ).not.toBeInTheDocument();
    });

    await fireEvent.input(screen.getByLabelText(/Nome da branch/i), {
      target: { value: 'feature/new' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Criar' }));

    await waitFor(() => {
      expect(api.createWorktree).toHaveBeenCalledWith({
        body: {
          mode: 'new',
          branch: 'feature/new',
          profile: 'default',
          agents: ['claude', 'codex'],
        },
      });
    });
  });

  it('submits an explicit base branch when provided', async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.fetchBaseBranches).mockResolvedValue({
      branches: [{ name: 'release/base' }],
    });
    vi.mocked(api.createWorktree).mockResolvedValue({
      primaryBranch: 'feature/from-release',
      branches: ['feature/from-release'],
    });

    render(App);

    await openCreateDialogWithBaseAndSubmit('feature/from-release', 'release/base');

    await waitFor(() => {
      expect(api.createWorktree).toHaveBeenCalledWith({
        body: {
          mode: 'new',
          branch: 'feature/from-release',
          baseBranch: 'release/base',
          profile: 'default',
          agents: ['claude'],
        },
      });
    });
  });

  it('caches branch lists across dialog openings and only fetches each mode once', async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.fetchAvailableBranches)
      .mockResolvedValueOnce({ branches: [{ name: 'feature/local-only' }] })
      .mockResolvedValueOnce({
        branches: [{ name: 'feature/local-only' }, { name: 'feature/remote-only' }],
      });
    vi.mocked(api.fetchBaseBranches).mockResolvedValue({ branches: [{ name: 'main' }] });

    render(App);

    await fireEvent.click(screen.getByTitle('Novo worktree (Cmd+K)'));
    await screen.findByRole('heading', { name: 'Novo worktree' });

    await waitFor(() => {
      expect(api.fetchAvailableBranches).toHaveBeenCalledTimes(1);
      expect(api.fetchAvailableBranches).toHaveBeenCalledWith({
        query: { includeRemote: false },
      });
      expect(api.fetchBaseBranches).toHaveBeenCalledTimes(1);
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Usar uma branch existente' }));
    await fireEvent.click(await screen.findByRole('switch', { name: /incluir branches remotas/i }));

    await waitFor(() => {
      expect(api.fetchAvailableBranches).toHaveBeenCalledTimes(2);
      expect(api.fetchAvailableBranches).toHaveBeenLastCalledWith({
        query: { includeRemote: true },
      });
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fireEvent.click(screen.getByTitle('Novo worktree (Cmd+K)'));
    await screen.findByRole('heading', { name: 'Novo worktree' });

    await waitFor(() => {
      expect(api.fetchAvailableBranches).toHaveBeenCalledTimes(2);
      expect(api.fetchBaseBranches).toHaveBeenCalledTimes(1);
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Usar uma branch existente' }));
    await fireEvent.click(await screen.findByRole('switch', { name: /incluir branches remotas/i }));

    await waitFor(() => {
      expect(api.fetchAvailableBranches).toHaveBeenCalledTimes(2);
      expect(api.fetchBaseBranches).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the current branch list visible while remote branches are loading', async () => {
    const remoteBranches = deferred<Array<{ name: string }>>();

    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.fetchAvailableBranches)
      .mockResolvedValueOnce({ branches: [{ name: 'feature/local-only' }] })
      .mockReturnValueOnce(remoteBranches.promise.then((branches) => ({ branches })));

    render(App);

    await fireEvent.click(screen.getByTitle('Novo worktree (Cmd+K)'));
    await screen.findByRole('heading', { name: 'Novo worktree' });
    await fireEvent.click(screen.getByRole('button', { name: 'Usar uma branch existente' }));

    expect(await screen.findByRole('button', { name: 'feature/local-only' })).toBeInTheDocument();

    await fireEvent.click(await screen.findByRole('switch', { name: /incluir branches remotas/i }));

    expect(screen.getByRole('button', { name: 'feature/local-only' })).toBeInTheDocument();
    expect(screen.getByText('Atualizando…')).toBeInTheDocument();

    remoteBranches.resolve([{ name: 'feature/local-only' }, { name: 'feature/remote-only' }]);

    expect(await screen.findByRole('button', { name: 'feature/remote-only' })).toBeInTheDocument();
  });

  it('removes a worktree through the row menu', async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([createWorktree('feature/doomed', { mux: '✓' })]);

    render(App);

    await screen.findByTitle('feature/doomed');
    await fireEvent.click(screen.getByRole('button', { name: /ações de feature\/doomed/i }));
    // The top bar has a "Remover" too; scope to the row's own menu.
    const rowMenu = document.querySelector('[data-worktree-row-menu]') as HTMLElement;
    await fireEvent.click(within(rowMenu).getByRole('button', { name: 'Remover' }));

    const dialog = await screen.findByRole('dialog');
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Remover' }));

    await waitFor(() => {
      expect(api.removeWorktree).toHaveBeenCalledWith({
        params: { name: 'feature/doomed' },
      });
    });
  });

  it('merges a worktree through the row menu', async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([createWorktree('feature/ready', { mux: '✓' })]);

    render(App);

    await screen.findByTitle('feature/ready');
    await fireEvent.click(screen.getByRole('button', { name: /ações de feature\/ready/i }));
    const rowMenu = document.querySelector('[data-worktree-row-menu]') as HTMLElement;
    await fireEvent.click(within(rowMenu).getByRole('button', { name: 'Integrar' }));

    const dialog = await screen.findByRole('dialog');
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Integrar' }));

    await waitFor(() => {
      expect(api.mergeWorktree).toHaveBeenCalledWith({ params: { name: 'feature/ready' } });
    });
  });

  it('opens a closed worktree from the empty terminal surface', async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([
      createWorktree('feature/closed', { agentName: 'claude', agentLabel: 'Claude' }),
    ]);

    render(App);

    await screen.findByTitle('feature/closed');
    await fireEvent.click(screen.getByRole('button', { name: /abrir sessão/i }));

    await waitFor(() => {
      expect(api.openWorktree).toHaveBeenCalledWith({
        params: { name: 'feature/closed' },
        body: {},
      });
    });
  });
});
