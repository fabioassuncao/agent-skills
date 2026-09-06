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
  /** Worktrees, tmux sessions and the agent surface (phases 5–7). */
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
  fetchConfig: CAPABILITY.worktrees,
  fetchProject: CAPABILITY.worktrees,
  fetchWorktrees: CAPABILITY.worktrees,
  createWorktree: CAPABILITY.worktrees,
  removeWorktree: CAPABILITY.worktrees,
  openWorktree: CAPABILITY.worktrees,
  closeWorktree: CAPABILITY.worktrees,
  refreshWorktreeAgentTerminal: CAPABILITY.worktrees,
  setWorktreeArchived: CAPABILITY.worktrees,
  setWorktreeLabel: CAPABILITY.worktrees,
  setWorktreeProfile: CAPABILITY.worktrees,
  sendWorktreePrompt: CAPABILITY.worktrees,
  createWorktreeTab: CAPABILITY.worktrees,
  selectWorktreeTab: CAPABILITY.worktrees,
  deleteWorktreeTab: CAPABILITY.worktrees,
  mergeWorktree: CAPABILITY.worktrees,
  fetchWorktreeDiff: CAPABILITY.worktrees,
  fetchAvailableBranches: CAPABILITY.worktrees,
  fetchBaseBranches: CAPABILITY.worktrees,
  fetchAgents: CAPABILITY.worktrees,
  createAgent: CAPABILITY.worktrees,
  updateAgent: CAPABILITY.worktrees,
  deleteAgent: CAPABILITY.worktrees,
  validateAgent: CAPABILITY.worktrees,
  fetchAutoNameConfig: CAPABILITY.worktrees,
  setAutoRemoveOnMerge: CAPABILITY.worktrees,
  pullMain: CAPABILITY.worktrees,
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
