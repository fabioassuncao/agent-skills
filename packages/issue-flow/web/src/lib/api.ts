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
  AgentSessionRow,
  AgentsUiInterruptResponse,
  AgentsUiSendMessageRequest,
  AgentsUiSendMessageResponse,
  AgentsUiWorktreeConversationResponse,
  ConfigWriteResponse,
  DiagnosticsResponse,
  EffectiveConfigResponse,
  FileUploadResult,
  HealthResponse,
  JournalResponse,
  LinearIssuesResponse,
  PostWorktreeToLinearRequest,
  PostWorktreeToLinearResponse,
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
 * 1. The migration sensor is gone (§48.1); Linear is optional and reports its
 *    environment-backed availability explicitly.
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
let health: HealthResponse | null = null;

/**
 * Ask the monitor what it can do, once, before anything else runs.
 *
 * A failure here is not fatal: an empty capability list means every gated
 * surface reports itself unavailable, which is the correct answer when the
 * server cannot even be reached.
 */
export async function loadCapabilities(): Promise<HealthResponse | null> {
  try {
    // Through `fetch` rather than the typed client for one reason: this is the
    // **first** response of the page, and it is where the serving process's
    // identity is recorded (U17). The typed client returns only the body, so a
    // page that started here would have no baseline to compare against later.
    const response = await fetch(apiPaths.health, { cache: 'no-store' });
    observeInstance(response.headers);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const answer = (await response.json()) as HealthResponse;
    capabilities = Array.isArray(answer.capabilities) ? answer.capabilities : [];
    capabilitiesLoaded = true;
    health = answer;
    return answer;
  } catch {
    capabilities = [];
    capabilitiesLoaded = true;
    health = null;
    return null;
  }
}

/**
 * The health answer from the boot request, without asking again.
 *
 * `main.ts` calls `loadCapabilities()` **before** mounting anything, because
 * every gated surface asks `canCall(...)` while it is being constructed. The
 * shell needs two more fields from that same answer — the monitor's version for
 * the header chip, and the server's suggested refresh interval — and a second
 * `/api/health` on every page load would be a request that changes nothing.
 */
export function knownHealth(): HealthResponse | null {
  return health;
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
    supportsTabs: snapshot.supportsTabs,
    executionId: snapshot.executionId,
    issueRef: snapshot.issueRef,
    linearIssue: null,
  };
}

export async function fetchLinearIssues(): Promise<LinearIssuesResponse> {
  requireRoute('fetchLinearIssues');
  return api.fetchLinearIssues();
}

export async function postWorktreeToLinear(
  branch: string,
  request: PostWorktreeToLinearRequest,
): Promise<PostWorktreeToLinearResponse> {
  requireRoute('postWorktreeToLinear');
  return api.postWorktreeToLinear({ params: { name: branch }, body: request });
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

/* -------------------------------------------------------------------------- *
 * Agent sessions (§49.3)
 *
 * Not contract routes: `POST /api/sessions`, `DELETE /api/sessions/:id` and
 * `POST /api/sessions/:id/link` were added by phase 9B and the contract package
 * describes the ported WebMux surface, whose worktree verbs mean something
 * different. They go through `fetch` for the same reason the two header-driven
 * behaviours below do — and, exactly as there, this module stays the boundary:
 * no component calls `fetch`.
 * -------------------------------------------------------------------------- */

export interface OpenSessionRequest {
  agent?: string;
  branch?: string;
  label?: string;
  prompt?: string;
  /** Present → the session belongs to that issue's run. Absent → free (§49.2). */
  issueRef?: string;
}

export interface OpenedSession {
  branch: string;
  sessionId: string;
}

function readSessionRow(value: unknown): AgentSessionRow | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.branch !== 'string') return null;
  return {
    id: row.id,
    projectId: typeof row.projectId === 'string' ? row.projectId : null,
    branch: row.branch,
    provider: typeof row.provider === 'string' ? row.provider : '',
    label: typeof row.label === 'string' && row.label !== '' ? row.label : null,
    status: typeof row.status === 'string' ? row.status : 'idle',
    runId: typeof row.runId === 'string' ? row.runId : null,
    free: row.free === true,
  };
}

/**
 * Every agent session this monitor serves, across projects (§49.4, I5).
 *
 * The consolidated view answers "what is running anywhere", which a per-project
 * listing cannot: the dashboard would have to ask N times and would not know
 * what N was. A monitor that does not serve sessions answers an empty list, so
 * the caller never has to branch on that.
 */
export async function fetchAgentSessions(): Promise<AgentSessionRow[]> {
  if (!hasCapability(CAPABILITY.sessions) && !hasCapability(CAPABILITY.sessionOpen)) return [];
  try {
    const response = await fetch(`${apiBase}/api/agent-sessions?all=1`, { cache: 'no-store' });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    if (!Array.isArray(body)) return [];
    return body.map(readSessionRow).filter((row): row is AgentSessionRow => row !== null);
  } catch {
    return [];
  }
}

/** Whether this monitor can open, stop and link agent sessions. */
export function canOpenSessions(): boolean {
  return hasCapability(CAPABILITY.sessionOpen);
}

async function sessionRequest(
  path: string,
  init: RequestInit & { method: string },
): Promise<unknown> {
  if (!canOpenSessions()) throw new CapabilityUnavailableError('fetchSessions');
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

/**
 * Open a session — the one click of S1/I3.
 *
 * Every field is optional on purpose: a session with no issue, no branch and no
 * prompt is the free session of §49.2, and asking for any of them would be the
 * ceremony the mode exists to skip. The branch is generated server-side.
 */
export async function openSession(request: OpenSessionRequest = {}): Promise<OpenedSession> {
  const body = await sessionRequest('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(request),
  });
  const record = (body ?? {}) as { branch?: unknown; session?: { id?: unknown } };
  return {
    branch: typeof record.branch === 'string' ? record.branch : '',
    sessionId: typeof record.session?.id === 'string' ? record.session.id : '',
  };
}

/** Stop a session. The worktree survives unless `removeWorktree` says otherwise. */
export function stopSession(
  sessionId: string,
  options: { removeWorktree?: boolean } = {},
): Promise<unknown> {
  const query = options.removeWorktree === true ? '?removeWorktree=1' : '';
  return sessionRequest(`/api/sessions/${encodeURIComponent(sessionId)}${query}`, {
    method: 'DELETE',
  });
}

/**
 * Promote a free session to a run (S4/I4).
 *
 * The server refuses an issue with no run rather than creating one: a session
 * starting the pipeline is what §49.2 forbids literally.
 */
export function linkSession(sessionId: string, issueRef: string): Promise<unknown> {
  return sessionRequest(`/api/sessions/${encodeURIComponent(sessionId)}/link`, {
    method: 'POST',
    body: JSON.stringify({ issueRef }),
  });
}

/* -------------------------------------------------------------------------- *
 * The two header-driven behaviours
 * -------------------------------------------------------------------------- */

/**
 * Instance identity and conditional revalidation, the two things the typed
 * client cannot express.
 *
 * `createApi`'s `unwrapResponse` returns **only the body** — deliberately, so a
 * caller never has to think about transport. Two of the panel's behaviours are
 * *about* the transport and cannot be expressed through it:
 *
 * - `X-Issue-Flow-Instance` (U17): the identity of the process that served the
 *   assets. A change means `--restart-web` put new code behind the same origin
 *   and the page has to reload. It is a **response header**.
 * - `If-None-Match` / `304` (the ETag path): a status the contract deliberately
 *   does not declare, because a 304 has no body to type. Teaching the typed
 *   client about a bodiless status, only for this one route, would put the
 *   exception in the shared layer instead of at the one call site that needs it.
 *
 * So these two use `fetch` directly — but the **paths come from the contract**
 * (`apiPaths`) and so do the response types, so the contract stays the single
 * source of both. Components still never call `fetch`: this module remains the
 * boundary.
 */

let observedInstanceId: string | null = null;
let onInstanceChanged: (() => void) | null = null;

/** Test seam and reset path. */
export function resetInstanceIdentity(): void {
  observedInstanceId = null;
}

/**
 * Register what to do when the serving process is replaced.
 *
 * The panel reloads. This is the asset handoff after `--restart-web`, not a
 * session state — a page whose bundle came from a process that no longer exists
 * is showing code the server has stopped agreeing with.
 */
export function watchInstanceIdentity(onChange: () => void): void {
  onInstanceChanged = onChange;
}

/**
 * Record the identity of the process that answered.
 *
 * Returns true when it *changed* — the first observation is not a change, and a
 * server old enough not to send the header is not one either.
 */
export function observeInstance(headers: Headers): boolean {
  const instanceId = headers.get('X-Issue-Flow-Instance');
  if (instanceId === null) return false;
  if (observedInstanceId === null) {
    observedInstanceId = instanceId;
    return false;
  }
  if (observedInstanceId === instanceId) return false;
  observedInstanceId = instanceId;
  onInstanceChanged?.();
  return true;
}

function sessionQuery(sessionId: string | null): string {
  return sessionId === null ? '' : `?session=${encodeURIComponent(sessionId)}`;
}

export type StatusResult =
  | { kind: 'not-modified' }
  | { kind: 'snapshot'; snapshot: unknown; etag: string | null };

/**
 * `GET /api/status`, revalidated.
 *
 * A `304` is the normal answer while nothing changed, and it is why the
 * fallback interval costs almost nothing: the server hashes the serialized
 * snapshot, so an unchanged run re-sends no body at all.
 */
export async function fetchExecutionStatus(
  sessionId: string | null,
  etag: string | null,
): Promise<StatusResult> {
  const headers: Record<string, string> = {};
  if (etag !== null) headers['If-None-Match'] = etag;
  const response = await fetch(`${apiBase}${apiPaths.fetchStatus}${sessionQuery(sessionId)}`, {
    headers,
    cache: 'no-store',
  });
  if (observeInstance(response.headers)) return { kind: 'not-modified' };
  if (response.status === 304) return { kind: 'not-modified' };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return {
    kind: 'snapshot',
    snapshot: await response.json(),
    etag: response.headers.get('ETag'),
  };
}

export function fetchExecutionEvents(sessionId: string | null): Promise<JournalResponse> {
  return api.fetchEvents({ query: sessionId === null ? {} : { session: sessionId } });
}

export function fetchExecutionDiagnostics(sessionId: string | null): Promise<DiagnosticsResponse> {
  return api.fetchDiagnostics({ query: sessionId === null ? {} : { session: sessionId } });
}

export function fetchEffectiveConfig(sessionId: string | null): Promise<EffectiveConfigResponse> {
  return api.fetchEffectiveConfig({ query: sessionId === null ? {} : { session: sessionId } });
}

/**
 * The two write routes, and the only two (ADR-10).
 *
 * Both are gated by a capability rather than by a version, and both save a
 * preference for **future** executions — the state of a running one stays
 * read-only. `requireRoute` is what turns "this monitor is not on loopback"
 * into an honest message instead of a 403 the user has to decode.
 */
export function saveAgentPreference(body: Record<string, unknown>): Promise<ConfigWriteResponse> {
  requireRoute('writeAgentPreference');
  return api.writeAgentPreference({ body });
}

export function saveRoutingPreference(body: Record<string, unknown>): Promise<ConfigWriteResponse> {
  requireRoute('writeRoutingPreference');
  return api.writeRoutingPreference({ body });
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
