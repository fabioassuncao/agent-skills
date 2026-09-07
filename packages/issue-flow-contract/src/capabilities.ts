import { type ApiRouteName, SERVED_TODAY } from './contract.js';


export const CAPABILITY = {
  configAgentWrite: 'config:agent:write',
  configRoutingWrite: 'config:routing:write',
  streamSessions: 'stream:sessions',
  terminalAttach: 'terminal:attach',

  sessions: 'sessions',

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

  conversation: 'agent:conversation',

  services: 'services',

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
  attachAgentsWorktreeConversation: CAPABILITY.conversation,
  fetchAgentsWorktreeConversationHistory: CAPABILITY.conversation,
  sendAgentsWorktreeConversationMessage: CAPABILITY.conversation,
  interruptAgentsWorktreeConversation: CAPABILITY.conversation,
  syncWorktreePrs: CAPABILITY.pullRequests,
  fetchCiLogs: CAPABILITY.pullRequests,
};

export function capabilityForRoute(route: ApiRouteName): CapabilityName | null {
  return ROUTE_CAPABILITY[route] ?? null;
}


export function isRouteAvailable(
  route: ApiRouteName,
  capabilities: readonly string[],
): boolean {
  const capability = capabilityForRoute(route);
  if (capability !== null) return capabilities.includes(capability);
  return SERVED_TODAY.has(route);
}
