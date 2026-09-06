import {
  type ApiRouteName,
  apiPaths,
  CAPABILITY,
  type CapabilityName,
  createApi,
  isRouteAvailable,
} from '@issue-flow/contract';
import type {
  AgentDetails,
  AgentResponse,
  AgentsUiInterruptResponse,
  AgentsUiSendMessageRequest,
  AgentsUiSendMessageResponse,
  AgentsUiWorktreeConversationResponse,
  FileUploadResult,
  HealthResponse,
  ProjectInitPhase,
  ProjectInitState,
  ProjectSummary,
  ProjectWorktreeSnapshot,
  SessionSummary,
  UpsertCustomAgentRequest,
  ValidateCustomAgentResponse,
  WorktreeInfo,
  WorktreeTab,
} from './types';

/**
 * Every call the dashboard makes to its server.
 *
 * PORT of `frontend/src/lib/api.ts` @ d8c9d5f (350 lines). The upstream's
 * structure is kept exactly — a prefixed per-project client, an unprefixed hub
 * client, and one exported function per operation so components never call
 * `fetch` — and four things are adapted:
 *
 * 1. **Linear is gone** (ADR-14) and so is the migration sensor (§48.1).
 * 2. **Capabilities gate every surface.** The Issue Flow backend serves the
 *    execution half today; the worktree/session/agent half arrives with phases
 *    5–7, 10 and 14. Calling a route that has no backend would show the user a
 *    404; asking `/api/health` first shows them an honest "not available on
 *    this monitor". Never infer a capability from a version — the assets on
 *    screen may be newer than the process serving them.
 * 3. **The terminal socket is authenticated** (ADR-10): a token from
 *    `GET /api/terminal/token`, which only exists on a loopback binding.
 * 4. **Notifications come from `/api/stream`**, the Server-Sent Events channel
 *    the monitor already pushes on, rather than the upstream's
 *    `/api/notifications/stream`. There is no polling path here: §35 puts a
 *    hard 250 ms p95 ceiling on output→screen.
 */

/** The active project's URL prefix, taken from the first path segment. */
export const activePrefix: string = window.location.pathname.split('/')[1] ?? '';

/**
 * Base path for the active project's API and WebSocket calls.
 *
 * A **reserved** first segment is not a project prefix: `src/web/router.ts`
 * keeps `api`, `ws`, `assets` and `health` out of the project namespace, so a
 * page served at `/api/...` (which should not happen, but does under a
 * misconfigured proxy) must not derive a prefix from it.
 */
const RESERVED_SEGMENTS = new Set(['api', 'ws', 'assets', 'health', 'legacy']);
export const apiBase: string =
  activePrefix && !RESERVED_SEGMENTS.has(activePrefix) ? `/${activePrefix}` : '';

/** Per-project client — every worktree/agent/config call is scoped to it. */
export const api = createApi(apiBase);

/** Hub client — the project list and its mutations are global (no prefix). */
const hubApi = createApi('');

/* -------------------------------------------------------------------------- *
 * Capabilities
 * -------------------------------------------------------------------------- */

let capabilities: readonly string[] = [];
let capabilitiesLoaded = false;

/**
 * Ask the monitor what it can do, once, before anything else runs.
 *
 * A failure here is not fatal: an empty capability list means every gated
 * surface reports itself unavailable, which is the correct answer when the
 * server cannot even be reached.
 */
export async function loadCapabilities(): Promise<HealthResponse | null> {
  try {
    const health = await hubApi.health();
    capabilities = health.capabilities;
    capabilitiesLoaded = true;
    return health;
  } catch {
    capabilities = [];
    capabilitiesLoaded = true;
    return null;
  }
}

export function knownCapabilities(): readonly string[] {
  return capabilities;
}

export function hasCapability(name: CapabilityName): boolean {
  return capabilities.includes(name);
}

export function canCall(route: ApiRouteName): boolean {
  return isRouteAvailable(route, capabilities);
}

/** Test seam and reset path; `loadCapabilities` is the production entry. */
export function setCapabilities(next: readonly string[]): void {
  capabilities = [...next];
  capabilitiesLoaded = true;
}

export function capabilitiesAreLoaded(): boolean {
  return capabilitiesLoaded;
}

/**
 * The error a gated surface raises when its backend is not there.
 *
 * A distinct class rather than a generic `Error` so a caller can tell "this
 * monitor does not do that" from "that request failed" — the first is a state
 * to render, the second is a failure to report.
 */
export class CapabilityUnavailableError extends Error {
  readonly route: ApiRouteName;

  constructor(route: ApiRouteName) {
    super('Este recurso não está disponível neste monitor.');
    this.name = 'CapabilityUnavailableError';
    this.route = route;
  }
}

function requireRoute(route: ApiRouteName): void {
  if (!canCall(route)) throw new CapabilityUnavailableError(route);
}

/* -------------------------------------------------------------------------- *
 * Worktrees and sessions
 * -------------------------------------------------------------------------- */

function mapAgentStatus(status: string): string {
  switch (status) {
    case 'creating':
    case 'running':
    case 'starting':
      return 'working';
    case 'idle':
      return 'waiting';
    case 'stopped':
      return 'done';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

function mapWorktree(snapshot: ProjectWorktreeSnapshot): WorktreeInfo {
  return {
    branch: snapshot.branch,
    label: snapshot.label,
    ...(snapshot.baseBranch ? { baseBranch: snapshot.baseBranch } : {}),
    archived: snapshot.archived,
    agent: mapAgentStatus(snapshot.status),
    mux: snapshot.mux ? '✓' : '',
    path: snapshot.path,
    dir: snapshot.dir,
    dirty: snapshot.dirty,
    unpushed: snapshot.unpushed,
    status: snapshot.status,
    elapsed: snapshot.elapsed,
    profile: snapshot.profile,
    agentName: snapshot.agentName,
    agentLabel: snapshot.agentLabel,
    agentTerminalStale: snapshot.agentTerminalStale,
    services: snapshot.services,
    paneCount: snapshot.paneCount,
    prs: snapshot.prs,
    creating: snapshot.creation !== null,
    creationPhase: snapshot.creation?.phase ?? null,
    source: snapshot.source,
    oneshot: snapshot.oneshot,
    tabs: snapshot.tabs,
    activeTabId: snapshot.activeTabId,
    executionId: snapshot.executionId,
    issueRef: snapshot.issueRef,
  };
}

export async function fetchWorktrees(): Promise<WorktreeInfo[]> {
  requireRoute('fetchWorktrees');
  const response = await api.fetchWorktrees();
  return response.worktrees.map((worktree) => mapWorktree(worktree));
}

export async function createWorktreeTab(branch: string): Promise<WorktreeTab> {
  requireRoute('createWorktreeTab');
  const response = await api.createWorktreeTab({ params: { name: branch } });
  return response.tab;
}

export function selectWorktreeTab(branch: string, tabId: string): Promise<void> {
  requireRoute('selectWorktreeTab');
  return api.selectWorktreeTab({ params: { name: branch, tabId } }).then(() => undefined);
}

export function deleteWorktreeTab(branch: string, tabId: string): Promise<void> {
  requireRoute('deleteWorktreeTab');
  return api.deleteWorktreeTab({ params: { name: branch, tabId } }).then(() => undefined);
}

export async function setWorktreeLabel(
  branch: string,
  label: string | null,
): Promise<string | null> {
  requireRoute('setWorktreeLabel');
  const response = await api.setWorktreeLabel({
    params: { name: branch },
    body: { label },
  });
  return response.label;
}

export async function setWorktreeProfile(
  branch: string,
  profile: string,
): Promise<{ profile: string; restarted: boolean }> {
  requireRoute('setWorktreeProfile');
  const response = await api.setWorktreeProfile({
    params: { name: branch },
    body: { profile },
  });
  return { profile: response.profile, restarted: response.restarted };
}

export function refreshWorktreeAgentTerminal(branch: string): Promise<void> {
  requireRoute('refreshWorktreeAgentTerminal');
  return api.refreshWorktreeAgentTerminal({ params: { name: branch } }).then(() => undefined);
}

/* -------------------------------------------------------------------------- *
 * Structured conversation
 * -------------------------------------------------------------------------- */

export function attachWorktreeConversation(
  branch: string,
): Promise<AgentsUiWorktreeConversationResponse> {
  requireRoute('attachAgentsWorktreeConversation');
  return api.attachAgentsWorktreeConversation({ params: { name: branch } });
}

export function fetchWorktreeConversationHistory(
  branch: string,
): Promise<AgentsUiWorktreeConversationResponse> {
  requireRoute('fetchAgentsWorktreeConversationHistory');
  return api.fetchAgentsWorktreeConversationHistory({ params: { name: branch } });
}

export function sendWorktreeConversationMessage(
  branch: string,
  body: AgentsUiSendMessageRequest,
): Promise<AgentsUiSendMessageResponse> {
  requireRoute('sendAgentsWorktreeConversationMessage');
  return api.sendAgentsWorktreeConversationMessage({ params: { name: branch }, body });
}

export function interruptWorktreeConversation(branch: string): Promise<AgentsUiInterruptResponse> {
  requireRoute('interruptAgentsWorktreeConversation');
  return api.interruptAgentsWorktreeConversation({ params: { name: branch } });
}

function withWorktreeName(path: string, branch: string): string {
  return path.replace(':name', encodeURIComponent(branch));
}

function webSocketOrigin(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}`;
}

export function connectWorktreeConversationStream(
  branch: string,
  callbacks: {
    onEvent: (event: unknown) => void;
    onError: (message: string) => void;
    onClose?: () => void;
  },
): () => void {
  const socket = new WebSocket(
    `${webSocketOrigin()}${apiBase}${withWorktreeName(
      apiPaths.streamAgentsWorktreeConversation,
      branch,
    )}`,
  );
  let closedByClient = false;

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    try {
      callbacks.onEvent(JSON.parse(event.data));
    } catch {
      callbacks.onError('Dados malformados no fluxo da conversa.');
    }
  });

  socket.addEventListener('error', () => {
    callbacks.onError('Falha na conexão do fluxo da conversa.');
  });

  socket.addEventListener('close', () => {
    if (!closedByClient) callbacks.onClose?.();
  });

  return () => {
    closedByClient = true;
    socket.close();
  };
}

/* -------------------------------------------------------------------------- *
 * Terminal
 * -------------------------------------------------------------------------- */

/**
 * Build the authenticated terminal URL.
 *
 * The token is fetched per connection rather than cached: it is minted per
 * server process, and a cached one silently stops working the moment the
 * monitor is replaced (`--restart-web`), which reads as "the terminal broke".
 *
 * `session` is the key, not the branch (§48.3) — a worktree can hold more than
 * one session, and the branch stopped being enough to name one.
 */
export async function terminalSocketUrl(target: {
  sessionId?: string | null;
  branch?: string | null;
}): Promise<string> {
  requireRoute('terminalToken');
  const { token, path } = await api.terminalToken();
  const url = new URL(`${webSocketOrigin()}${apiBase}${path}`);
  url.searchParams.set('token', token);
  if (target.sessionId) url.searchParams.set('session', target.sessionId);
  if (target.branch) url.searchParams.set('branch', target.branch);
  return url.toString();
}

/* -------------------------------------------------------------------------- *
 * Agents
 * -------------------------------------------------------------------------- */

export function fetchAgents(): Promise<AgentDetails[]> {
  requireRoute('fetchAgents');
  return api.fetchAgents().then((response) => response.agents);
}

export function createAgent(body: UpsertCustomAgentRequest): Promise<AgentResponse> {
  requireRoute('createAgent');
  return api.createAgent({ body });
}

export function updateAgent(id: string, body: UpsertCustomAgentRequest): Promise<AgentResponse> {
  requireRoute('updateAgent');
  return api.updateAgent({ params: { id }, body });
}

export function deleteAgent(id: string): Promise<void> {
  requireRoute('deleteAgent');
  return api.deleteAgent({ params: { id } }).then(() => undefined);
}

export function validateAgent(
  body: UpsertCustomAgentRequest,
): Promise<ValidateCustomAgentResponse> {
  requireRoute('validateAgent');
  return api.validateAgent({ body });
}

/* -------------------------------------------------------------------------- *
 * Projects
 * -------------------------------------------------------------------------- */

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const response = await hubApi.fetchProjects();
  return response.projects;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SETUP_POLL_INTERVAL_MS = 600;
const SETUP_TIMEOUT_MS = 5 * 60_000;

/**
 * Add a project and, when the repository still needs the convention scaffold,
 * drive its setup to completion, reporting each phase via `onPhase`.
 *
 * A transient poll failure does not fail the flow — the server-side job keeps
 * running, so it is swallowed and retried until the deadline. That detail is
 * the upstream's and it is the difference between "the network hiccuped" and
 * "your project failed to set up".
 */
export async function setUpProject(
  path: string,
  onPhase?: (phase: ProjectInitPhase) => void,
): Promise<{ prefix: string }> {
  const response = await hubApi.addProject({ body: { path } });
  if (!response.initializing) {
    const prefix = response.project?.prefix;
    if (!prefix) {
      throw new Error('O servidor aceitou o projeto mas não devolveu nada para abrir.');
    }
    return { prefix };
  }

  const deadline = Date.now() + SETUP_TIMEOUT_MS;
  let lastPhase: ProjectInitPhase | null = null;
  while (Date.now() < deadline) {
    const inits = await hubApi
      .projectInits()
      .then((result) => result.inits)
      .catch((): ProjectInitState[] => []);
    const state = inits.find((entry) => entry.path === response.path);
    if (state) {
      if (state.phase !== lastPhase) {
        lastPhase = state.phase;
        onPhase?.(state.phase);
      }
      if (state.phase === 'ready' && state.prefix) return { prefix: state.prefix };
      if (state.phase === 'failed') {
        throw new Error(state.error ?? 'A preparação do projeto falhou.');
      }
    }
    await delay(SETUP_POLL_INTERVAL_MS);
  }
  throw new Error('A preparação do projeto excedeu o tempo limite.');
}

export async function removeProject(prefix: string): Promise<void> {
  await hubApi.removeProject({ params: { prefix } });
}

export type ProjectBootstrap = 'ready' | 'redirecting' | 'no-projects' | 'single';

/**
 * Decide what to mount before the app loads.
 *
 * One case the upstream does not have and that matters here: a monitor bound
 * inline by a pipeline run serves **no** project surface at all and answers an
 * empty list. That is not "no projects registered" — it is "this monitor is
 * watching one execution" — so it mounts the dashboard rather than the guided
 * empty state, which is what keeps a plain `issue-flow run` unchanged (ADR-03).
 */
export async function ensureProjectPrefix(): Promise<ProjectBootstrap> {
  const projects = await fetchProjects().catch((): ProjectSummary[] => []);
  if (projects.length === 0) {
    // No registry at all: either a pipeline-bound monitor (which has sessions
    // to show) or a genuinely empty install (which does not).
    const sessions = await fetchSessions().catch((): SessionSummary[] => []);
    return sessions.length > 0 ? 'single' : 'no-projects';
  }
  if (projects.some((project) => project.prefix === activePrefix)) return 'ready';
  const served = projects.filter((project) => project.served && project.prefix);
  // Only one project is being served, and the URL has no prefix: that is the
  // single-project experience the router preserves. Do not redirect.
  if (served.length === 0) return 'single';
  const target = served[0]?.prefix;
  if (!target) return 'single';
  window.location.replace(`/${target}/`);
  return 'redirecting';
}

/* -------------------------------------------------------------------------- *
 * Executions
 * -------------------------------------------------------------------------- */

export function fetchSessions(): Promise<SessionSummary[]> {
  return api.fetchSessions();
}

/**
 * Subscribe to the monitor's push channel.
 *
 * `/api/stream` is Server-Sent Events carrying reduced JSON in one direction —
 * it reconnects on its own, needs no framing and no dependency. The named
 * events are the server's (`sessions`, `status`); anything else is ignored
 * rather than guessed at.
 */
export function subscribeSessions(callbacks: {
  onSessions?: (sessions: SessionSummary[]) => void;
  onStatus?: (snapshot: unknown) => void;
  onError?: () => void;
}): () => void {
  const source = new EventSource(`${apiBase}${apiPaths.streamSessions}`);

  source.addEventListener('sessions', (event: MessageEvent) => {
    try {
      callbacks.onSessions?.(JSON.parse(event.data as string) as SessionSummary[]);
    } catch {
      // Malformed frame — the next one supersedes it.
    }
  });

  source.addEventListener('status', (event: MessageEvent) => {
    try {
      callbacks.onStatus?.(JSON.parse(event.data as string));
    } catch {
      // Same.
    }
  });

  source.addEventListener('error', () => {
    callbacks.onError?.();
  });

  return () => source.close();
}

/* -------------------------------------------------------------------------- *
 * File upload
 * -------------------------------------------------------------------------- */

/**
 * Upload dropped or pasted images so the agent can be handed their paths.
 *
 * The upstream posts to `/api/worktrees/:name/upload`. Issue Flow has no such
 * route and this port does not invent one: the call reports itself unavailable
 * so the terminal writes an honest `[Erro no envio: …]` line instead of a 404
 * the user has to decode.
 */
export function uploadFiles(_worktree: string, _files: File[]): Promise<FileUploadResult> {
  return Promise.reject(new Error('O envio de arquivos ainda não está disponível neste monitor.'));
}

export { CAPABILITY };
