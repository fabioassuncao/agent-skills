import { type ApiRouteName, SERVED_TODAY } from './contract.js';

/**
 * What a monitor announces it can do.
 *
 * ADDITION over the upstream, and the rule the existing dashboard already
 * follows (`web/AGENTS.md`): never infer a capability from a version number.
 * The assets on screen may be newer than the process serving them, because a
 * pipeline run reuses whatever instance already holds the lock — so
 * `GET /api/health.capabilities` is the only truthful signal, and a surface
 * that is not announced is not offered.
 */
export const CAPABILITY = {
  configAgentWrite: 'config:agent:write',
  configRoutingWrite: 'config:routing:write',
  streamSessions: 'stream:sessions',
  terminalAttach: 'terminal:attach',
  /**
   * Listing the agent sessions of a project and the worktrees they run in.
   *
   * Split out of `worktrees` in phase 8D. The two are different promises and
   * conflating them cost the dashboard its whole session surface: `worktrees`
   * gates twenty-odd *mutation* routes ported ahead of their backends, so a
   * monitor that can list sessions perfectly well could not say so without also
   * claiming it could merge, archive and re-profile them — and every one of
   * those would have 404'd.
   */
  sessions: 'sessions',
  /**
   * Opening, stopping and linking an agent session (§49.3).
   *
   * Announced only where a session could actually be opened: a monitor with no
   * project surface answers 501 and one that is not on loopback answers 403
   * (ADR-10), and a button that leads to either is a button that lies.
   */
  sessionOpen: 'session:open',
  /** Listing and validating built-in/custom agents; safe on remote listeners. */
  agentsRead: 'agents:read',
  /** Persisting custom agents; announced only on a writable loopback listener. */
  agentsWrite: 'agents:write',
  /** Reading assigned Linear issues; safe on remote listeners. */
  linearRead: 'linear:read',
  /** Posting conversations and changing Linear automation; loopback only. */
  linearWrite: 'linear:write',
  /** Project integration toggles such as GitHub GC; loopback only. */
  settingsWrite: 'settings:write',
  /** Block A: create, open, close, integrate and curate worktrees. */
  worktreeMutations: 'worktrees:mutate',
  /** Create, select and close AgentSession tabs in one worktree. */
  worktreeTabs: 'worktrees:tabs',
  /** Non-destructive terminal reattach/resume. */
  terminalRefresh: 'terminal:refresh',
  /** Later agent/settings/tab worktree surfaces, not implied by Block A. */
  worktrees: 'worktrees',
  /** The structured conversation channel (§45.2-A/B). */
  conversation: 'agent:conversation',
  /** Service health per worktree (§19). */
  services: 'services',
  /** PR and CI, from the canonical service (§20). */
  pullRequests: 'pr:ci',
} as const;

export type CapabilityName = (typeof CAPABILITY)[keyof typeof CAPABILITY];

/** Which capability, if any, gates a route. */
const ROUTE_CAPABILITY: Partial<Record<ApiRouteName, CapabilityName>> = {
  writeAgentPreference: CAPABILITY.configAgentWrite,
  writeRoutingPreference: CAPABILITY.configRoutingWrite,
  streamSessions: CAPABILITY.streamSessions,
  terminalToken: CAPABILITY.terminalAttach,
  streamTerminal: CAPABILITY.terminalAttach,
  fetchConfig: CAPABILITY.worktreeMutations,
  fetchProject: CAPABILITY.worktrees,
  // The listing, and only the listing: phase 8D serves it from the agent
  // sessions of §49 (`src/web/worktrees-api.ts`). Everything below still waits
  // for the worktree mutation backend.
  fetchWorktrees: CAPABILITY.sessions,
  createWorktree: CAPABILITY.worktreeMutations,
  removeWorktree: CAPABILITY.worktreeMutations,
  openWorktree: CAPABILITY.worktreeMutations,
  closeWorktree: CAPABILITY.worktreeMutations,
  refreshWorktreeAgentTerminal: CAPABILITY.terminalRefresh,
  setWorktreeArchived: CAPABILITY.worktreeMutations,
  setWorktreeLabel: CAPABILITY.worktreeMutations,
  setWorktreeProfile: CAPABILITY.worktreeMutations,
  sendWorktreePrompt: CAPABILITY.worktreeMutations,
  createWorktreeTab: CAPABILITY.worktreeTabs,
  selectWorktreeTab: CAPABILITY.worktreeTabs,
  deleteWorktreeTab: CAPABILITY.worktreeTabs,
  mergeWorktree: CAPABILITY.worktreeMutations,
  fetchWorktreeDiff: CAPABILITY.worktreeMutations,
  fetchAvailableBranches: CAPABILITY.worktreeMutations,
  fetchBaseBranches: CAPABILITY.worktreeMutations,
  fetchAgents: CAPABILITY.agentsRead,
  createAgent: CAPABILITY.agentsWrite,
  updateAgent: CAPABILITY.agentsWrite,
  deleteAgent: CAPABILITY.agentsWrite,
  validateAgent: CAPABILITY.agentsRead,
  // Provider-neutral naming policy is read-only and always served by the
  // monitor; like every ungated SERVED_TODAY route it stays available remotely.
  fetchLinearIssues: CAPABILITY.linearRead,
  setLinearAutoCreate: CAPABILITY.linearWrite,
  postWorktreeToLinear: CAPABILITY.linearWrite,
  setAutoRemoveOnMerge: CAPABILITY.settingsWrite,
  pullMain: CAPABILITY.worktreeMutations,
  dismissNotification: CAPABILITY.worktrees,
  attachAgentsWorktreeConversation: CAPABILITY.conversation,
  fetchAgentsWorktreeConversationHistory: CAPABILITY.conversation,
  sendAgentsWorktreeConversationMessage: CAPABILITY.conversation,
  interruptAgentsWorktreeConversation: CAPABILITY.conversation,
  streamAgentsWorktreeConversation: CAPABILITY.conversation,
  syncWorktreePrs: CAPABILITY.pullRequests,
  fetchCiLogs: CAPABILITY.pullRequests,
};

export function capabilityForRoute(route: ApiRouteName): CapabilityName | null {
  return ROUTE_CAPABILITY[route] ?? null;
}

/**
 * Whether a monitor that announced `capabilities` can answer `route`.
 *
 * An ungated route that `SERVED_TODAY` knows about is always available; an
 * ungated route that it does not is one this frontend was ported ahead of, and
 * calling it would 404. Both answers are honest, and neither is a guess.
 */
export function isRouteAvailable(
  route: ApiRouteName,
  capabilities: readonly string[],
): boolean {
  const capability = capabilityForRoute(route);
  if (capability !== null) return capabilities.includes(capability);
  return SERVED_TODAY.has(route);
}
