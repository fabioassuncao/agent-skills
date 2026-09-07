import { initContract } from '@ts-rest/core';
import {
  AddProjectRequestSchema,
  AddProjectResponseSchema,
  AgentEventsResponseSchema,
  AgentIdParamsSchema,
  AgentListResponseSchema,
  AgentResponseSchema,
  AgentsSendMessageRequestSchema,
  AgentsUiInterruptResponseSchema,
  AgentsUiSendMessageResponseSchema,
  AgentsUiWorktreeConversationResponseSchema,
  AppConfigSchema,
  AutoNameConfigResponseSchema,
  AvailableBranchesQuerySchema,
  BranchListResponseSchema,
  CiLogsResponseSchema,
  ConfigWriteRequestSchema,
  ConfigWriteResponseSchema,
  CreateTabResponseSchema,
  CreateWorktreeRequestSchema,
  CreateWorktreeResponseSchema,
  DiagnosticsResponseSchema,
  EffectiveConfigResponseSchema,
  EnabledResponseSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  JournalResponseSchema,
  LinearIssuesResponseSchema,
  NotificationIdParamsSchema,
  OkResponseSchema,
  OpenWorktreeRequestSchema,
  PostWorktreeToLinearRequestSchema,
  PostWorktreeToLinearResponseSchema,
  ProjectInitsResponseSchema,
  ProjectPrefixParamsSchema,
  ProjectSnapshotSchema,
  ProjectsResponseSchema,
  ProjectWorktreeSnapshotSchema,
  PullMainRequestSchema,
  PullMainResponseSchema,
  RemoveProjectResponseSchema,
  RunIdParamsSchema,
  SendWorktreePromptRequestSchema,
  SessionListResponseSchema,
  SessionQuerySchema,
  SessionSnapshotSchema,
  SetWorktreeArchivedRequestSchema,
  SetWorktreeArchivedResponseSchema,
  SetWorktreeLabelRequestSchema,
  SetWorktreeLabelResponseSchema,
  SetWorktreeProfileRequestSchema,
  SetWorktreeProfileResponseSchema,
  TerminalTokenResponseSchema,
  ToggleEnabledRequestSchema,
  UpsertCustomAgentRequestSchema,
  ValidateCustomAgentResponseSchema,
  WorktreeDiffResponseSchema,
  WorktreeListResponseSchema,
  WorktreeNameParamsSchema,
  WorktreeTabParamsSchema,
} from './schemas.js';

/**
 * The Issue Flow HTTP contract.
 *
 * PORT of `packages/api-contract/src/contract.ts` from windmill-labs/webmux
 * @ d8c9d5f (527 lines). The router shape, the `apiPaths` map and
 * `strictStatusCodes` are the upstream's; what changed is the route set:
 *
 * - the migration sensor (`/api/instances`, `/api/projects/migrate`) is gone;
 *   the optional Linear routes use an environment-only credential and expose
 *   availability explicitly instead of persisting authentication material;
 * - the terminal socket is keyed by **session**, not by branch (§48.3), and it
 *   carries a token (ADR-10) — the upstream's unauthenticated
 *   `WS /<prefix>/ws/:branch` is not portable as-is;
 * - the execution half of Issue Flow (`/api/sessions`, `/api/status`,
 *   `/api/events`, `/api/agent-events`, `/api/diagnostics`, `/api/config`,
 *   `/api/health`, `/api/stream`) is added — those are the routes
 *   `src/web/server.ts` serves today.
 *
 * `SERVED_TODAY` below is not decoration: it is what the dashboard reads to
 * decide whether a surface can be offered at all. A route in the ported
 * worktree half has no backend behind it until phases 5–7, 10 and 14 land, and
 * a dashboard that called it anyway would show the user a 404 instead of an
 * honest "not available on this monitor".
 */

const c = initContract();

export const apiPaths = {
  /* Executions — Issue Flow, served today. */
  health: '/api/health',
  fetchSessions: '/api/sessions',
  fetchStatus: '/api/status',
  fetchEvents: '/api/events',
  fetchAgentEvents: '/api/agent-events',
  fetchDiagnostics: '/api/diagnostics',
  fetchEffectiveConfig: '/api/config',
  writeAgentPreference: '/api/config/agent',
  writeRoutingPreference: '/api/config/routing',
  streamSessions: '/api/stream',
  terminalToken: '/api/terminal/token',
  streamTerminal: '/ws/terminal',

  /* Projects — the unified registry (§47), served today. */
  fetchProjects: '/api/projects',
  addProject: '/api/projects',
  projectInits: '/api/project-inits',
  removeProject: '/api/projects/:prefix',

  /* Worktrees, sessions and agents — ported from WebMux, backed by phases 5–7. */
  fetchConfig: '/api/config/project',
  fetchAvailableBranches: '/api/branches',
  fetchBaseBranches: '/api/base-branches',
  fetchProject: '/api/project',
  fetchAgents: '/api/agents',
  createAgent: '/api/agents',
  updateAgent: '/api/agents/:id',
  deleteAgent: '/api/agents/:id',
  validateAgent: '/api/agents/validate',
  attachAgentsWorktreeConversation: '/api/agents/worktrees/:name/attach',
  fetchAgentsWorktreeConversationHistory: '/api/agents/worktrees/:name/history',
  sendAgentsWorktreeConversationMessage: '/api/agents/worktrees/:name/messages',
  interruptAgentsWorktreeConversation: '/api/agents/worktrees/:name/interrupt',
  streamAgentsWorktreeConversation: '/ws/conversation/:name',
  fetchWorktrees: '/api/worktrees',
  createWorktree: '/api/worktrees',
  removeWorktree: '/api/worktrees/:name',
  openWorktree: '/api/worktrees/:name/open',
  closeWorktree: '/api/worktrees/:name/close',
  refreshWorktreeAgentTerminal: '/api/worktrees/:name/agent-terminal/refresh',
  setWorktreeArchived: '/api/worktrees/:name/archive',
  syncWorktreePrs: '/api/worktrees/:name/sync-prs',
  setWorktreeLabel: '/api/worktrees/:name/label',
  setWorktreeProfile: '/api/worktrees/:name/profile',
  sendWorktreePrompt: '/api/worktrees/:name/send',
  createWorktreeTab: '/api/worktrees/:name/tabs',
  selectWorktreeTab: '/api/worktrees/:name/tabs/:tabId/select',
  deleteWorktreeTab: '/api/worktrees/:name/tabs/:tabId',
  mergeWorktree: '/api/worktrees/:name/merge',
  fetchWorktreeDiff: '/api/worktrees/:name/diff',
  fetchAutoNameConfig: '/api/project/auto-name',
  fetchLinearIssues: '/api/linear/issues',
  setLinearAutoCreate: '/api/linear/auto-create',
  postWorktreeToLinear: '/api/worktrees/:name/linear',
  setAutoRemoveOnMerge: '/api/github/auto-remove-on-merge',
  pullMain: '/api/pull-main',
  fetchCiLogs: '/api/ci-logs/:runId',
  dismissNotification: '/api/notifications/:id/dismiss',
} as const;

export type ApiRouteName = keyof typeof apiPaths;

/**
 * Routes `packages/issue-flow/src/web/server.ts` answers today.
 *
 * Verified against that file, not assumed. Everything absent from this set is
 * ported ahead of its backend and must be reached only behind a capability
 * check — see `capabilities.ts`.
 */
export const SERVED_TODAY: ReadonlySet<ApiRouteName> = new Set<ApiRouteName>([
  'health',
  'fetchSessions',
  'fetchStatus',
  'fetchEvents',
  'fetchAgentEvents',
  'fetchDiagnostics',
  'fetchEffectiveConfig',
  'writeAgentPreference',
  'writeRoutingPreference',
  'streamSessions',
  'terminalToken',
  'streamTerminal',
  'fetchProjects',
  'addProject',
  'projectInits',
  'removeProject',
  'fetchWorktrees',
  'fetchConfig',
  'createWorktree',
  'removeWorktree',
  'openWorktree',
  'closeWorktree',
  'refreshWorktreeAgentTerminal',
  'setWorktreeArchived',
  'setWorktreeLabel',
  'setWorktreeProfile',
  'sendWorktreePrompt',
  'createWorktreeTab',
  'selectWorktreeTab',
  'deleteWorktreeTab',
  'mergeWorktree',
  'fetchWorktreeDiff',
  'fetchAvailableBranches',
  'fetchBaseBranches',
  'pullMain',
  'syncWorktreePrs',
  'fetchCiLogs',
  'fetchAgents',
  'createAgent',
  'updateAgent',
  'deleteAgent',
  'validateAgent',
  'fetchLinearIssues',
  'setLinearAutoCreate',
  'postWorktreeToLinear',
  'setAutoRemoveOnMerge',
  'fetchAutoNameConfig',
]);

const commonErrorResponses = {
  400: ErrorResponseSchema,
  412: ErrorResponseSchema,
  413: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  500: ErrorResponseSchema,
  501: ErrorResponseSchema,
  502: ErrorResponseSchema,
  503: ErrorResponseSchema,
} as const;

export const apiContract = c.router(
  {
    /* --------------------------------------------------------------------- *
     * Executions — Issue Flow
     * --------------------------------------------------------------------- */
    health: {
      method: 'GET',
      path: apiPaths.health,
      responses: {
        200: HealthResponseSchema,
      },
    },
    fetchSessions: {
      method: 'GET',
      path: apiPaths.fetchSessions,
      responses: {
        200: SessionListResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    fetchStatus: {
      method: 'GET',
      path: apiPaths.fetchStatus,
      query: SessionQuerySchema,
      responses: {
        200: SessionSnapshotSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
      },
    },
    fetchEvents: {
      method: 'GET',
      path: apiPaths.fetchEvents,
      query: SessionQuerySchema,
      responses: {
        200: JournalResponseSchema,
        400: ErrorResponseSchema,
        404: ErrorResponseSchema,
      },
    },
    fetchAgentEvents: {
      method: 'GET',
      path: apiPaths.fetchAgentEvents,
      query: SessionQuerySchema,
      responses: {
        200: AgentEventsResponseSchema,
        400: ErrorResponseSchema,
        404: ErrorResponseSchema,
      },
    },
    fetchDiagnostics: {
      method: 'GET',
      path: apiPaths.fetchDiagnostics,
      query: SessionQuerySchema,
      responses: {
        200: DiagnosticsResponseSchema,
      },
    },
    fetchEffectiveConfig: {
      method: 'GET',
      path: apiPaths.fetchEffectiveConfig,
      query: SessionQuerySchema,
      responses: {
        200: EffectiveConfigResponseSchema,
      },
    },
    writeAgentPreference: {
      method: 'POST',
      path: apiPaths.writeAgentPreference,
      body: ConfigWriteRequestSchema,
      responses: {
        200: ConfigWriteResponseSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    writeRoutingPreference: {
      method: 'POST',
      path: apiPaths.writeRoutingPreference,
      body: ConfigWriteRequestSchema,
      responses: {
        200: ConfigWriteResponseSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    terminalToken: {
      method: 'GET',
      path: apiPaths.terminalToken,
      responses: {
        200: TerminalTokenResponseSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
      },
    },

    /* --------------------------------------------------------------------- *
     * Projects
     * --------------------------------------------------------------------- */
    fetchProjects: {
      method: 'GET',
      path: apiPaths.fetchProjects,
      responses: {
        200: ProjectsResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    addProject: {
      method: 'POST',
      path: apiPaths.addProject,
      body: AddProjectRequestSchema,
      responses: {
        200: AddProjectResponseSchema,
        202: AddProjectResponseSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    projectInits: {
      method: 'GET',
      path: apiPaths.projectInits,
      responses: {
        200: ProjectInitsResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    removeProject: {
      method: 'DELETE',
      path: apiPaths.removeProject,
      pathParams: ProjectPrefixParamsSchema,
      body: c.noBody(),
      responses: {
        200: RemoveProjectResponseSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
      },
    },

    /* --------------------------------------------------------------------- *
     * Worktrees, sessions and agents — ported ahead of their backend
     * --------------------------------------------------------------------- */
    fetchConfig: {
      method: 'GET',
      path: apiPaths.fetchConfig,
      responses: {
        200: AppConfigSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
    },
    fetchAvailableBranches: {
      method: 'GET',
      path: apiPaths.fetchAvailableBranches,
      query: AvailableBranchesQuerySchema,
      responses: {
        200: BranchListResponseSchema,
        400: ErrorResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
    },
    fetchBaseBranches: {
      method: 'GET',
      path: apiPaths.fetchBaseBranches,
      responses: {
        200: BranchListResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
    },
    fetchProject: {
      method: 'GET',
      path: apiPaths.fetchProject,
      responses: {
        200: ProjectSnapshotSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
        502: ErrorResponseSchema,
      },
    },
    fetchAgents: {
      method: 'GET',
      path: apiPaths.fetchAgents,
      responses: {
        200: AgentListResponseSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
    },
    createAgent: {
      method: 'POST',
      path: apiPaths.createAgent,
      body: UpsertCustomAgentRequestSchema,
      responses: {
        200: AgentResponseSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
    },
    updateAgent: {
      method: 'PUT',
      path: apiPaths.updateAgent,
      pathParams: AgentIdParamsSchema,
      body: UpsertCustomAgentRequestSchema,
      responses: {
        200: AgentResponseSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
        500: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
    },
    deleteAgent: {
      method: 'DELETE',
      path: apiPaths.deleteAgent,
      pathParams: AgentIdParamsSchema,
      body: c.noBody(),
      responses: {
        200: OkResponseSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
    },
    validateAgent: {
      method: 'POST',
      path: apiPaths.validateAgent,
      body: UpsertCustomAgentRequestSchema,
      responses: {
        200: ValidateCustomAgentResponseSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
    },
    attachAgentsWorktreeConversation: {
      method: 'POST',
      path: apiPaths.attachAgentsWorktreeConversation,
      pathParams: WorktreeNameParamsSchema,
      body: c.noBody(),
      responses: {
        200: AgentsUiWorktreeConversationResponseSchema,
        ...commonErrorResponses,
      },
    },
    fetchAgentsWorktreeConversationHistory: {
      method: 'GET',
      path: apiPaths.fetchAgentsWorktreeConversationHistory,
      pathParams: WorktreeNameParamsSchema,
      responses: {
        200: AgentsUiWorktreeConversationResponseSchema,
        ...commonErrorResponses,
      },
    },
    sendAgentsWorktreeConversationMessage: {
      method: 'POST',
      path: apiPaths.sendAgentsWorktreeConversationMessage,
      pathParams: WorktreeNameParamsSchema,
      body: AgentsSendMessageRequestSchema,
      responses: {
        200: AgentsUiSendMessageResponseSchema,
        ...commonErrorResponses,
      },
    },
    interruptAgentsWorktreeConversation: {
      method: 'POST',
      path: apiPaths.interruptAgentsWorktreeConversation,
      pathParams: WorktreeNameParamsSchema,
      body: c.noBody(),
      responses: {
        200: AgentsUiInterruptResponseSchema,
        ...commonErrorResponses,
      },
    },
    fetchWorktrees: {
      method: 'GET',
      path: apiPaths.fetchWorktrees,
      responses: {
        200: WorktreeListResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
        502: ErrorResponseSchema,
      },
    },
    createWorktree: {
      method: 'POST',
      path: apiPaths.createWorktree,
      body: CreateWorktreeRequestSchema,
      responses: {
        201: CreateWorktreeResponseSchema,
        ...commonErrorResponses,
      },
    },
    removeWorktree: {
      method: 'DELETE',
      path: apiPaths.removeWorktree,
      pathParams: WorktreeNameParamsSchema,
      responses: {
        200: OkResponseSchema,
        ...commonErrorResponses,
      },
    },
    openWorktree: {
      method: 'POST',
      path: apiPaths.openWorktree,
      pathParams: WorktreeNameParamsSchema,
      body: OpenWorktreeRequestSchema,
      responses: {
        200: OkResponseSchema,
        ...commonErrorResponses,
      },
    },
    closeWorktree: {
      method: 'POST',
      path: apiPaths.closeWorktree,
      pathParams: WorktreeNameParamsSchema,
      body: c.noBody(),
      responses: {
        200: OkResponseSchema,
        ...commonErrorResponses,
      },
    },
    refreshWorktreeAgentTerminal: {
      method: 'POST',
      path: apiPaths.refreshWorktreeAgentTerminal,
      pathParams: WorktreeNameParamsSchema,
      body: c.noBody(),
      responses: {
        200: OkResponseSchema,
        ...commonErrorResponses,
      },
    },
    setWorktreeArchived: {
      method: 'PUT',
      path: apiPaths.setWorktreeArchived,
      pathParams: WorktreeNameParamsSchema,
      body: SetWorktreeArchivedRequestSchema,
      responses: {
        200: SetWorktreeArchivedResponseSchema,
        ...commonErrorResponses,
      },
    },
    syncWorktreePrs: {
      method: 'POST',
      path: apiPaths.syncWorktreePrs,
      pathParams: WorktreeNameParamsSchema,
      body: c.noBody(),
      responses: {
        200: ProjectWorktreeSnapshotSchema,
        ...commonErrorResponses,
      },
    },
    setWorktreeLabel: {
      method: 'PUT',
      path: apiPaths.setWorktreeLabel,
      pathParams: WorktreeNameParamsSchema,
      body: SetWorktreeLabelRequestSchema,
      responses: {
        200: SetWorktreeLabelResponseSchema,
        ...commonErrorResponses,
      },
    },
    setWorktreeProfile: {
      method: 'PUT',
      path: apiPaths.setWorktreeProfile,
      pathParams: WorktreeNameParamsSchema,
      body: SetWorktreeProfileRequestSchema,
      responses: {
        200: SetWorktreeProfileResponseSchema,
        ...commonErrorResponses,
      },
    },
    sendWorktreePrompt: {
      method: 'POST',
      path: apiPaths.sendWorktreePrompt,
      pathParams: WorktreeNameParamsSchema,
      body: SendWorktreePromptRequestSchema,
      responses: {
        200: OkResponseSchema,
        ...commonErrorResponses,
      },
    },
    createWorktreeTab: {
      method: 'POST',
      path: apiPaths.createWorktreeTab,
      pathParams: WorktreeNameParamsSchema,
      body: c.noBody(),
      responses: {
        201: CreateTabResponseSchema,
        ...commonErrorResponses,
      },
    },
    selectWorktreeTab: {
      method: 'POST',
      path: apiPaths.selectWorktreeTab,
      pathParams: WorktreeTabParamsSchema,
      body: c.noBody(),
      responses: {
        200: OkResponseSchema,
        ...commonErrorResponses,
      },
    },
    deleteWorktreeTab: {
      method: 'DELETE',
      path: apiPaths.deleteWorktreeTab,
      pathParams: WorktreeTabParamsSchema,
      responses: {
        200: OkResponseSchema,
        ...commonErrorResponses,
      },
    },
    mergeWorktree: {
      method: 'POST',
      path: apiPaths.mergeWorktree,
      pathParams: WorktreeNameParamsSchema,
      body: c.noBody(),
      responses: {
        200: OkResponseSchema,
        ...commonErrorResponses,
      },
    },
    fetchWorktreeDiff: {
      method: 'GET',
      path: apiPaths.fetchWorktreeDiff,
      pathParams: WorktreeNameParamsSchema,
      responses: {
        200: WorktreeDiffResponseSchema,
        ...commonErrorResponses,
      },
    },
    fetchAutoNameConfig: {
      method: 'GET',
      path: apiPaths.fetchAutoNameConfig,
      responses: {
        200: AutoNameConfigResponseSchema,
        404: ErrorResponseSchema,
        500: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
    },
    fetchLinearIssues: {
      method: 'GET',
      path: apiPaths.fetchLinearIssues,
      responses: {
        200: LinearIssuesResponseSchema,
        ...commonErrorResponses,
      },
    },
    setLinearAutoCreate: {
      method: 'PUT',
      path: apiPaths.setLinearAutoCreate,
      body: ToggleEnabledRequestSchema,
      responses: {
        200: EnabledResponseSchema,
        ...commonErrorResponses,
      },
    },
    postWorktreeToLinear: {
      method: 'POST',
      path: apiPaths.postWorktreeToLinear,
      pathParams: WorktreeNameParamsSchema,
      body: PostWorktreeToLinearRequestSchema,
      responses: {
        200: PostWorktreeToLinearResponseSchema,
        ...commonErrorResponses,
      },
    },
    setAutoRemoveOnMerge: {
      method: 'PUT',
      path: apiPaths.setAutoRemoveOnMerge,
      body: ToggleEnabledRequestSchema,
      responses: {
        200: EnabledResponseSchema,
        ...commonErrorResponses,
      },
    },
    pullMain: {
      method: 'POST',
      path: apiPaths.pullMain,
      body: PullMainRequestSchema,
      responses: {
        200: PullMainResponseSchema,
        ...commonErrorResponses,
      },
    },
    fetchCiLogs: {
      method: 'GET',
      path: apiPaths.fetchCiLogs,
      pathParams: RunIdParamsSchema,
      responses: {
        200: CiLogsResponseSchema,
        ...commonErrorResponses,
      },
    },
    dismissNotification: {
      method: 'POST',
      path: apiPaths.dismissNotification,
      pathParams: NotificationIdParamsSchema,
      body: c.noBody(),
      responses: {
        200: OkResponseSchema,
        400: ErrorResponseSchema,
        404: ErrorResponseSchema,
      },
    },
  },
  {
    strictStatusCodes: true,
  },
);
