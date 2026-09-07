import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  CAPABILITY: {
    configAgentWrite: 'config:agent:write',
    configRoutingWrite: 'config:routing:write',
    streamSessions: 'stream:sessions',
    terminalAttach: 'terminal:attach',
    worktreeMutations: 'worktrees:mutate',
    worktrees: 'worktrees',
    conversation: 'agent:conversation',
    services: 'services',
    pullRequests: 'pr:ci',
  },
  canCall: vi.fn(() => true),
  hasCapability: vi.fn(() => true),
  fetchEffectiveConfig: vi.fn(),
  saveAgentPreference: vi.fn(),
  saveRoutingPreference: vi.fn(),
}));

import {
  canCall,
  fetchEffectiveConfig,
  hasCapability,
  saveAgentPreference,
  saveRoutingPreference,
} from './api';
import PreferenceForms from './PreferenceForms.svelte';

/**
 * **U8** — two preference forms, on loopback only, only with the capability
 * announced.
 *
 * The rule the current panel already enforces and this port carries over:
 * **never infer permission from a version**. The assets on screen can be newer
 * than the process serving them, so `/api/health.capabilities` is the only
 * truthful signal, and the server announces the two writes only on a loopback
 * binding (ADR-10).
 */

const CONFIG = {
  effective: {
    defaultProvider: { value: 'codex', source: 'global' },
    defaultModel: { value: 'gpt-5', source: 'global' },
  },
  capturedForSession: null,
  routing: { mode: 'shadow', profile: 'quality', policy: 'adaptive' },
  catalog: [
    {
      harness: 'claude',
      provider: 'claude',
      installed: true,
      authenticated: true,
      authentication: 'ok',
      state: 'ready',
      source: 'path',
      observedAt: null,
      expiresAt: null,
      detail: null,
      models: [],
    },
    {
      harness: 'codex',
      provider: 'codex',
      installed: true,
      authenticated: true,
      authentication: 'ok',
      state: 'ready',
      source: 'path',
      observedAt: null,
      expiresAt: null,
      detail: null,
      models: [],
    },
    {
      harness: 'cursor',
      provider: 'cursor',
      installed: false,
      authenticated: false,
      authentication: 'missing',
      state: 'unavailable',
      source: 'path',
      observedAt: null,
      expiresAt: null,
      detail: null,
      models: [],
    },
  ],
  writable: true,
  writeScope: 'global preferences for future executions',
};

beforeEach(() => {
  vi.mocked(canCall).mockReturnValue(true);
  vi.mocked(hasCapability).mockReturnValue(true);
  vi.mocked(fetchEffectiveConfig).mockResolvedValue(CONFIG as never);
  vi.mocked(saveAgentPreference).mockResolvedValue({ ok: true } as never);
  vi.mocked(saveRoutingPreference).mockResolvedValue({ ok: true } as never);
});

afterEach(cleanup);

describe('the two preference forms (U8)', () => {
  it('renders exactly two, seeded from the effective configuration', async () => {
    render(PreferenceForms, { props: { config: CONFIG as never } });

    const provider = (await screen.findByLabelText(
      'Harness padrão para execuções futuras',
    )) as HTMLSelectElement;
    expect(provider.value).toBe('codex');
    // Only harnesses that are installed and usable are offered.
    expect(Array.from(provider.options).map((option) => option.value)).toEqual(['claude', 'codex']);

    expect(screen.getByLabelText('Modelo padrão para execuções futuras')).toHaveValue('gpt-5');
    expect(screen.getByLabelText('Modo de routing')).toHaveValue('shadow');
    expect(screen.getByLabelText('Perfil de routing')).toHaveValue('quality');
  });

  it('says the writes apply to future executions, not to the run on screen', async () => {
    render(PreferenceForms, { props: { config: CONFIG as never } });
    expect(await screen.findByText(/O estado das execuções é somente leitura/)).toBeInTheDocument();
  });

  it('saves the harness preference and reports it', async () => {
    render(PreferenceForms, { props: { config: CONFIG as never } });

    await fireEvent.click(await screen.findByRole('button', { name: 'Salvar preferência global' }));
    await waitFor(() => {
      expect(saveAgentPreference).toHaveBeenCalledWith({ provider: 'codex', model: 'gpt-5' });
    });
    expect(await screen.findByText('salvo para execuções futuras')).toBeInTheDocument();
  });

  it('saves routing, and applies the recommended policy on its own button', async () => {
    render(PreferenceForms, { props: { config: CONFIG as never } });

    await fireEvent.click(await screen.findByRole('button', { name: 'Salvar routing' }));
    await waitFor(() => {
      expect(saveRoutingPreference).toHaveBeenCalledWith({ mode: 'shadow', profile: 'quality' });
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Aplicar política recomendada' }));
    await waitFor(() => {
      expect(saveRoutingPreference).toHaveBeenCalledWith({ policy: 'recommended' });
    });
  });

  it('reports a refused write instead of pretending it succeeded', async () => {
    vi.mocked(saveAgentPreference).mockRejectedValue(
      new Error('Este recurso não está disponível neste monitor.'),
    );
    render(PreferenceForms, { props: { config: CONFIG as never } });

    await fireEvent.click(await screen.findByRole('button', { name: 'Salvar preferência global' }));
    expect(
      await screen.findByText('Este recurso não está disponível neste monitor.'),
    ).toBeInTheDocument();
  });

  it('renders nothing at all without the capabilities', () => {
    // A monitor reachable from the network shows the configuration and offers
    // nothing to change.
    vi.mocked(hasCapability).mockReturnValue(false);
    const { container } = render(PreferenceForms, { props: { config: CONFIG as never } });
    expect(container.textContent).toBe('');
  });

  it('renders neither form when the routes are not callable', () => {
    vi.mocked(canCall).mockReturnValue(false);
    const { container } = render(PreferenceForms, { props: { config: CONFIG as never } });
    expect(container.textContent).toBe('');
  });

  it('fetches the configuration itself when the shell has none', async () => {
    render(PreferenceForms);
    await waitFor(() => {
      expect(screen.getByLabelText('Modo de routing')).toHaveValue('shadow');
    });
    expect(fetchEffectiveConfig).toHaveBeenCalledWith(null);
  });
});
