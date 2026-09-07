// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${PROMPT}` is a
// literal placeholder the agent runtime substitutes as argv, not a template
// string this file is meant to interpolate.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDetails, AgentSummary, AppConfig } from './types';

/**
 * PORT of `frontend/src/lib/SettingsDialog.test.ts` @ d8c9d5f — 4 cases, plus 1
 * for the capability gate, including the optional Linear automation toggle.
 */

vi.mock('./api', () => ({
  CAPABILITY: {
    configAgentWrite: 'config:agent:write',
    configRoutingWrite: 'config:routing:write',
    streamSessions: 'stream:sessions',
    terminalAttach: 'terminal:attach',
    sessions: 'sessions',
    worktreeMutations: 'worktrees:mutate',
    worktrees: 'worktrees',
    conversation: 'agent:conversation',
    services: 'services',
    pullRequests: 'pr:ci',
  },
  api: {
    fetchConfig: vi.fn(),
    setAutoRemoveOnMerge: vi.fn(),
    setLinearAutoCreate: vi.fn(),
  },
  canCall: vi.fn(() => true),
  hasCapability: vi.fn(() => true),
  fetchAgents: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  validateAgent: vi.fn(),
  // §50.3 merged the panel's two preference forms into this dialog, so the
  // dialog now reaches the execution-configuration half of the API too.
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
}));

import {
  api,
  canCall,
  createAgent,
  deleteAgent,
  fetchAgents,
  hasCapability,
  validateAgent,
} from './api';
import SettingsDialog from './SettingsDialog.svelte';

const originalDialogShowModal = HTMLDialogElement.prototype.showModal;
const originalDialogClose = HTMLDialogElement.prototype.close;

const BUILTIN_CAPABILITIES = {
  terminal: true as const,
  inAppChat: true,
  conversationHistory: true,
  interrupt: true,
  resume: true,
};

function createAgentDetails(overrides: Partial<AgentDetails> = {}): AgentDetails {
  return {
    id: 'gemini',
    label: 'Gemini CLI',
    kind: 'custom',
    capabilities: {
      terminal: true,
      inAppChat: false,
      conversationHistory: false,
      interrupt: false,
      resume: true,
    },
    startCommand: 'gemini --prompt "${PROMPT}"',
    resumeCommand: 'gemini resume --branch "${BRANCH}"',
    ...overrides,
  };
}

function createAgentSummary(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: 'gemini',
    label: 'Gemini CLI',
    kind: 'custom',
    capabilities: {
      terminal: true,
      inAppChat: false,
      conversationHistory: false,
      interrupt: false,
      resume: true,
    },
    ...overrides,
  };
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    name: 'repo',
    services: [],
    profiles: [{ name: 'default' }],
    agents: [],
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
    ...overrides,
  };
}

function renderDialog(props: Record<string, unknown> = {}) {
  return render(SettingsDialog, {
    currentTheme: 'system',
    useWebChatUi: false,
    autoRemoveOnMerge: false,
    linearAutoCreate: false,
    linearAvailability: 'disabled',
    onthemechange: vi.fn(),
    onwebchatuichange: vi.fn(),
    onautoremovechange: vi.fn(),
    onlinearautocreatechange: vi.fn(),
    onagentschange: vi.fn(),
    onsave: vi.fn(),
    onclose: vi.fn(),
    ...props,
  });
}

describe('SettingsDialog agent management', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(canCall).mockReturnValue(true);
    vi.mocked(hasCapability).mockReturnValue(true);
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
  });

  afterEach(() => {
    HTMLDialogElement.prototype.showModal = originalDialogShowModal;
    HTMLDialogElement.prototype.close = originalDialogClose;
    cleanup();
    vi.clearAllMocks();
  });

  it('shows only custom agents in the list', async () => {
    vi.mocked(fetchAgents).mockResolvedValue([
      createAgentDetails({
        id: 'claude',
        label: 'Claude',
        kind: 'builtin',
        startCommand: null,
        resumeCommand: null,
        capabilities: BUILTIN_CAPABILITIES,
      }),
      createAgentDetails(),
    ]);

    renderDialog();

    await screen.findByText('Gemini CLI');
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
    expect(screen.getByText('gemini --prompt "${PROMPT}"')).toBeInTheDocument();
  });

  it('reports web chat UI preference changes', async () => {
    const onwebchatuichange = vi.fn();
    vi.mocked(fetchAgents).mockResolvedValue([]);

    renderDialog({ onwebchatuichange });

    await fireEvent.click(screen.getByRole('switch', { name: 'Usar o chat na página' }));

    expect(onwebchatuichange).toHaveBeenCalledWith(true);
  });

  it('saves the SSH host used by Abrir no Cursor', async () => {
    const onsave = vi.fn();
    vi.mocked(fetchAgents).mockResolvedValue([]);
    renderDialog({ onsave });

    await fireEvent.input(screen.getByLabelText(/Host SSH/), { target: { value: 'devbox' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(onsave).toHaveBeenCalledWith('devbox');
    expect(localStorage.getItem('issue-flow:ssh-host')).toBe('devbox');
  });

  it('persists the Linear auto-create toggle when the key is available', async () => {
    const onlinearautocreatechange = vi.fn();
    vi.mocked(fetchAgents).mockResolvedValue([]);
    vi.mocked(api.setLinearAutoCreate).mockResolvedValue({ ok: true, enabled: true });
    renderDialog({ linearAvailability: 'ready', onlinearautocreatechange });

    await fireEvent.click(
      screen.getByRole('switch', {
        name: 'Criar worktrees automaticamente a partir do Linear',
      }),
    );
    await waitFor(() =>
      expect(api.setLinearAutoCreate).toHaveBeenCalledWith({ body: { enabled: true } }),
    );
    expect(onlinearautocreatechange).toHaveBeenCalledWith(true);
  });

  it('shows an empty state when no custom agents are configured', async () => {
    vi.mocked(fetchAgents).mockResolvedValue([
      createAgentDetails({
        id: 'claude',
        label: 'Claude',
        kind: 'builtin',
        startCommand: null,
        resumeCommand: null,
        capabilities: BUILTIN_CAPABILITIES,
      }),
    ]);

    renderDialog();

    expect(await screen.findByText('Nenhum agente personalizado configurado')).toBeInTheDocument();
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
  });

  it('hides agent management on a monitor that does not announce it', async () => {
    vi.mocked(canCall).mockReturnValue(false);
    vi.mocked(hasCapability).mockReturnValue(false);

    renderDialog();

    expect(
      await screen.findByText('Este monitor não gerencia agentes personalizados.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adicionar' })).not.toBeInTheDocument();
    expect(fetchAgents).not.toHaveBeenCalled();
  });

  it('lists agents but hides mutations when only the remote-safe capability exists', async () => {
    vi.mocked(canCall).mockImplementation((route) => route === 'fetchAgents');
    vi.mocked(fetchAgents).mockResolvedValue([createAgentDetails()]);

    renderDialog();

    expect(await screen.findByText('Gemini CLI')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adicionar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Excluir' })).not.toBeInTheDocument();
  });

  it('validates, creates, and deletes custom agents', async () => {
    const onagentschange = vi.fn();
    vi.mocked(fetchAgents)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createAgentDetails()])
      .mockResolvedValueOnce([]);
    vi.mocked(createAgent).mockResolvedValue({ agent: createAgentDetails() });
    vi.mocked(validateAgent).mockResolvedValue({ normalizedId: 'gemini-cli', warnings: [] });
    vi.mocked(deleteAgent).mockResolvedValue();
    vi.mocked(api.fetchConfig)
      .mockResolvedValueOnce(createConfig({ agents: [createAgentSummary()] }))
      .mockResolvedValueOnce(createConfig({ agents: [] }));

    renderDialog({ onagentschange });

    await screen.findByText('Adicionar');
    await fireEvent.click(screen.getByRole('button', { name: 'Adicionar' }));
    expect(screen.getByText('${PERMISSION}')).toBeInTheDocument();
    await fireEvent.input(screen.getByLabelText('Nome do agente'), {
      target: { value: 'Gemini CLI' },
    });
    await fireEvent.input(screen.getByLabelText('Comando de início'), {
      target: { value: 'gemini --prompt "${PROMPT}"' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Testar' }));

    await waitFor(() => {
      expect(validateAgent).toHaveBeenCalledWith({
        label: 'Gemini CLI',
        startCommand: 'gemini --prompt "${PROMPT}"',
      });
    });
    expect(await screen.findByText('A configuração parece correta.')).toBeInTheDocument();

    const saveButtons = screen.getAllByRole('button', { name: 'Salvar' });
    await fireEvent.click(saveButtons[saveButtons.length - 1]);

    await waitFor(() => {
      expect(createAgent).toHaveBeenCalledWith({
        label: 'Gemini CLI',
        startCommand: 'gemini --prompt "${PROMPT}"',
      });
    });
    await waitFor(() => {
      expect(onagentschange).toHaveBeenCalledWith([createAgentSummary()]);
    });

    await fireEvent.click(await screen.findByRole('button', { name: 'Excluir' }));
    // The row's "Excluir" and the confirmation's are both on screen now; the
    // confirmation is the submit button.
    const confirmButtons = screen.getAllByRole('button', { name: 'Excluir' });
    await fireEvent.click(
      confirmButtons.find((button) => button.getAttribute('type') === 'submit') as HTMLElement,
    );

    await waitFor(() => {
      expect(deleteAgent).toHaveBeenCalledWith('gemini');
    });
    await waitFor(() => {
      expect(onagentschange).toHaveBeenCalledWith([]);
    });
  });
});
