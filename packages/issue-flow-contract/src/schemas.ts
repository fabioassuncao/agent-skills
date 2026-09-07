import { z } from 'zod';

/**
 * The shapes the Issue Flow monitor server and its dashboard agree on.
 *
 * PORT of `packages/api-contract/src/schemas.ts` from windmill-labs/webmux
 * @ d8c9d5f (776 lines), with three deliberate differences:
 *
 * - **Linear is optional and environment-authenticated.** Its UI shapes are
 *   retained, but no schema can carry a credential or persist one in project
 *   configuration.
 * - **The migration sensor is gone.** `InstanceSummary` / `MigrateProjects*`
 *   existed to feed `MigrationBanner.svelte`, which is a WebMux-internal
 *   migration (§48.1). Nothing here replaces them.
 * - **The Issue Flow half is added**: sessions, snapshots, journal events, agent
 *   lifecycle events, diagnostics, effective configuration and health — the
 *   surface `src/web/server.ts` already serves. These are the routes that back
 *   the dashboard today.
 *
 * Everything else keeps the upstream's names, so the two files read side by
 * side.
 */

const BooleanLikeSchema = z.union([
  z.boolean(),
  z.literal('true').transform(() => true),
  z.literal('false').transform(() => false),
]);

export const ErrorResponseSchema = z.object({
  error: z.string(),
});

export const OkResponseSchema = z.object({
  ok: z.literal(true),
});

export const EnabledResponseSchema = z.object({
  ok: z.literal(true),
  enabled: z.boolean(),
});

/**
 * The five providers Issue Flow ships with, against the upstream's two.
 *
 * `AgentIdSchema` stays a free string because custom agents are registered by
 * id (§45.2-L absorbs the custom-agent concept and nothing else from the
 * upstream's agent layer).
 */
export const BuiltInAgentIdSchema = z.enum([
  'claude',
  'codex',
  'cursor',
  'antigravity',
  'opencode',
]);
export const AgentIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const AgentKindSchema = BuiltInAgentIdSchema;
export const WorktreeCreateModeSchema = z.enum(['new', 'existing']);

export const AgentCapabilitiesSchema = z.object({
  terminal: z.literal(true),
  inAppChat: z.boolean(),
  conversationHistory: z.boolean(),
  interrupt: z.boolean(),
  resume: z.boolean(),
});

export const AgentSummarySchema = z.object({
  id: AgentIdSchema,
  label: z.string(),
  kind: z.enum(['builtin', 'custom']),
  capabilities: AgentCapabilitiesSchema,
});

export const AgentDetailsSchema = z.object({
  id: AgentIdSchema,
  label: z.string(),
  kind: z.enum(['builtin', 'custom']),
  capabilities: AgentCapabilitiesSchema,
  startCommand: z.string().nullable(),
  resumeCommand: z.string().nullable(),
});

export const AgentListResponseSchema = z.object({
  agents: z.array(AgentDetailsSchema),
});

export const UpsertCustomAgentRequestSchema = z.object({
  label: z.string().trim().min(1),
  startCommand: z.string().trim().min(1),
  resumeCommand: z.string().trim().optional(),
});

export const AgentResponseSchema = z.object({
  agent: AgentDetailsSchema,
});

export const ValidateCustomAgentResponseSchema = z.object({
  normalizedId: AgentIdSchema,
  warnings: z.array(z.string()),
});

export const WorktreeCreationPhaseSchema = z.enum([
  'creating_worktree',
  'preparing_runtime',
  'running_post_create_hook',
  'starting_session',
  'reconciling',
]);

export const AvailableBranchSchema = z.object({
  name: z.string(),
});

export const AvailableBranchesQuerySchema = z.object({
  includeRemote: BooleanLikeSchema.optional(),
});

const NumberLikePathParamSchema = z.union([
  z.number().int().nonnegative(),
  z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Number(value)),
]);

export const BranchListResponseSchema = z.object({
  branches: z.array(AvailableBranchSchema),
});

export const WorktreeSourceSchema = z.enum(['ui', 'oneshot']);

/**
 * Oneshot watch config carried on create/open requests. When present, the
 * server-side oneshot watcher closes the session once the agent finishes. Any
 * browser-originated interaction with the session disarms the watcher.
 *
 * The upstream's implicit `postToLinearOnDone` remains out. Linear posting is
 * restored as an explicit UI/API action, separate from oneshot completion.
 */
export const OneshotConfigSchema = z.object({
  autoCloseOnDone: z.boolean().optional(),
});

/**
 * Creating a worktree.
 *
 * `issueRef` is the Issue Flow addition of §48.3: a free session can be opened
 * with no issue at all (ADR-16), and the same dialog links one when the user
 * wants the workflow.
 */
export const CreateWorktreeRequestSchema = z.object({
  mode: WorktreeCreateModeSchema.optional(),
  branch: z.string().optional(),
  baseBranch: z.string().optional(),
  profile: z.string().optional(),
  agent: AgentIdSchema.optional(),
  agents: z.array(AgentIdSchema).min(1).optional(),
  prompt: z.string().optional(),
  envOverrides: z.record(z.string()).optional(),
  issueRef: z.string().trim().min(1).optional(),
  source: WorktreeSourceSchema.optional(),
  oneshot: OneshotConfigSchema.optional(),
});

export const OpenWorktreeRequestSchema = z.object({
  prompt: z.string().optional(),
  oneshot: OneshotConfigSchema.optional(),
});

export const CreateWorktreeResponseSchema = z.object({
  primaryBranch: z.string(),
  branches: z.array(z.string()),
});

export const SetWorktreeArchivedRequestSchema = z.object({
  archived: z.boolean(),
});

export const SetWorktreeArchivedResponseSchema = z.object({
  ok: z.literal(true),
  archived: z.boolean(),
});

export const SetWorktreeLabelRequestSchema = z.object({
  label: z.string().trim().max(80).nullable(),
});

export const SetWorktreeLabelResponseSchema = z.object({
  ok: z.literal(true),
  label: z.string().nullable(),
});

export const SetWorktreeProfileRequestSchema = z.object({
  profile: z.string().trim().min(1),
});

export const SetWorktreeProfileResponseSchema = z.object({
  ok: z.literal(true),
  profile: z.string(),
  /**
   * True when the tmux session was rebuilt with the new profile's panes. False
   * when the worktree was closed — the new profile applies on next open.
   */
  restarted: z.boolean(),
});

export const ToggleEnabledRequestSchema = z.object({
  enabled: z.boolean(),
});

export const SendWorktreePromptRequestSchema = z.object({
  text: z.string().min(1),
  preamble: z.string().optional(),
});

export const AgentsSendMessageRequestSchema = z.object({
  text: z.string().trim().min(1),
});

export const PullMainRequestSchema = z.object({
  force: z.boolean().optional(),
  repo: z.string().optional(),
});

export const PullMainStatusSchema = z.enum([
  'updated',
  'already_up_to_date',
  'fetch_failed',
  'merge_failed',
]);

export const PullMainResponseSchema = z.object({
  status: PullMainStatusSchema,
  from: z.string().optional(),
  to: z.string().optional(),
  error: z.string().optional(),
});

export const ServiceStatusSchema = z.object({
  name: z.string(),
  port: z.number().nullable(),
  running: z.boolean(),
  url: z.string().nullable().optional(),
});

export const PrCommentSchema = z.object({
  type: z.enum(['comment', 'inline']),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  path: z.string().optional(),
  line: z.number().nullable().optional(),
  diffHunk: z.string().optional(),
  isReply: z.boolean().optional(),
});

export const CiCheckSchema = z.object({
  name: z.string(),
  status: z.enum(['pending', 'success', 'failed', 'skipped']),
  url: z.string().nullable(),
  runId: z.number().nullable(),
});

export const PrEntrySchema = z.object({
  repo: z.string(),
  number: z.number(),
  state: z.enum(['open', 'closed', 'merged']),
  isDraft: z.boolean(),
  url: z.string(),
  updatedAt: z.string(),
  ciStatus: z.enum(['none', 'pending', 'success', 'failed']),
  ciChecks: z.array(CiCheckSchema),
  comments: z.array(PrCommentSchema),
});

export const AutoNameConfigResponseSchema = z.object({
  autoName: z
    .object({
      maxLength: z.number().int().positive(),
      timeoutMs: z.number().int().positive(),
      systemPrompt: z.string(),
    })
    .nullable(),
});

export const LinearIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  priority: z.number(),
  priorityLabel: z.string(),
  url: z.string(),
  branchName: z.string(),
  dueDate: z.string().nullable(),
  updatedAt: z.string(),
  state: z.object({ name: z.string(), color: z.string(), type: z.string() }),
  team: z.object({ name: z.string(), key: z.string() }),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  project: z.string().nullable(),
});

export const LinearIssuesResponseSchema = z.object({
  availability: z.enum(['disabled', 'missing_api_key', 'ready']),
  issues: z.array(LinearIssueSchema),
});

export const LinearTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('issue'), issueId: z.string().trim().min(1) }),
  z.object({
    kind: z.literal('team'),
    teamKey: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9]*$/),
    title: z.string().trim().min(1).optional(),
  }),
]);

export const PostWorktreeToLinearRequestSchema = z.object({ target: LinearTargetSchema });
export const PostWorktreeToLinearResponseSchema = z.object({
  ok: z.literal(true),
  issueId: z.string(),
  issueUrl: z.string(),
  commentUrl: z.string().nullable(),
  attachmentUrl: z.string(),
});

export const WorktreeCreationStateSchema = z.object({
  phase: WorktreeCreationPhaseSchema,
});

export const AppNotificationSchema = z.object({
  id: z.number(),
  branch: z.string(),
  type: z.enum(['agent_stopped', 'pr_opened', 'runtime_error', 'worktree_auto_removed']),
  message: z.string(),
  url: z.string().optional(),
  timestamp: z.number(),
});

export const WorktreeTabSchema = z.object({
  tabId: z.string(),
  kind: z.enum(['root', 'fork']),
  label: z.string(),
  seq: z.number().nullable(),
  sessionId: z.string().nullable(),
  paneId: z.string().optional(),
  createdAt: z.string(),
});

/**
 * One worktree as the sidebar sees it.
 *
 * `executionId` and `issueRef` are the Issue Flow additions of §48.3: a
 * worktree may be the workspace of a workflow execution, and the sidebar has to
 * be able to say so without a second list.
 */
export const ProjectWorktreeSnapshotSchema = z.object({
  branch: z.string(),
  label: z.string().nullable(),
  baseBranch: z.string().optional(),
  path: z.string(),
  dir: z.string(),
  archived: z.boolean(),
  profile: z.string().nullable(),
  agentName: AgentIdSchema.nullable(),
  agentLabel: z.string().nullable(),
  agentTerminalStale: z.boolean(),
  mux: z.boolean(),
  dirty: z.boolean(),
  unpushed: z.boolean(),
  paneCount: z.number(),
  status: z.string(),
  elapsed: z.string(),
  services: z.array(ServiceStatusSchema),
  prs: z.array(PrEntrySchema),
  creation: WorktreeCreationStateSchema.nullable(),
  source: WorktreeSourceSchema,
  oneshot: OneshotConfigSchema.nullable(),
  /** Agent-pane tabs (`tabs[0]` is the root). Default keeps older servers valid. */
  tabs: z.array(WorktreeTabSchema).default([]),
  activeTabId: z.string().nullable().default(null),
  /** Runtime/provider capability for this row; sandbox currently cannot fork safely. */
  supportsTabs: z.boolean().default(false),
  /** Set when this worktree is the workspace of a workflow execution. */
  executionId: z.string().nullable().default(null),
  /** Set when the worktree is linked to an issue, with or without an execution. */
  issueRef: z.string().nullable().default(null),
});

export const ProjectSnapshotSchema = z.object({
  project: z.object({
    name: z.string(),
    mainBranch: z.string(),
  }),
  worktrees: z.array(ProjectWorktreeSnapshotSchema),
  notifications: z.array(AppNotificationSchema),
});

export const WorktreeConversationProviderSchema = z.enum(['codexAppServer', 'claudeCode']);

export const CodexWorktreeConversationRefSchema = z.object({
  provider: z.literal('codexAppServer'),
  conversationId: z.string(),
  cwd: z.string(),
  lastSeenAt: z.string(),
  threadId: z.string(),
});

export const ClaudeWorktreeConversationRefSchema = z.object({
  provider: z.literal('claudeCode'),
  conversationId: z.string(),
  cwd: z.string(),
  lastSeenAt: z.string(),
  sessionId: z.string(),
});

export const WorktreeConversationRefSchema = z.discriminatedUnion('provider', [
  CodexWorktreeConversationRefSchema,
  ClaudeWorktreeConversationRefSchema,
]);

export const AgentsUiWorktreeSummarySchema = z.object({
  branch: z.string(),
  baseBranch: z.string().optional(),
  path: z.string(),
  archived: z.boolean(),
  profile: z.string().nullable(),
  agentName: AgentIdSchema.nullable(),
  agentLabel: z.string().nullable(),
  agentTerminalStale: z.boolean(),
  mux: z.boolean(),
  status: z.string(),
  dirty: z.boolean(),
  unpushed: z.boolean(),
  services: z.array(ServiceStatusSchema),
  prs: z.array(PrEntrySchema),
  creating: z.boolean(),
  creationPhase: WorktreeCreationPhaseSchema.nullable(),
  conversation: WorktreeConversationRefSchema.nullable(),
});

export const AgentsUiConversationMessageRoleSchema = z.enum(['user', 'assistant']);
export const AgentsUiConversationMessageStatusSchema = z.enum([
  'completed',
  'inProgress',
  'failed',
]);
export const AgentsUiConversationMessageKindSchema = z.enum([
  'text',
  'thinking',
  'toolUse',
  'toolResult',
]);

export const AgentsUiConversationMessageSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  order: z.number().int().nonnegative(),
  role: AgentsUiConversationMessageRoleSchema,
  text: z.string(),
  status: AgentsUiConversationMessageStatusSchema,
  createdAt: z.string().nullable(),
  kind: AgentsUiConversationMessageKindSchema,
  phase: z.string().optional(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  durationMs: z.number().nullable().optional(),
});

export const AgentsUiConversationStateSchema = z.object({
  provider: WorktreeConversationProviderSchema,
  conversationId: z.string(),
  cwd: z.string(),
  running: z.boolean(),
  activeTurnId: z.string().nullable(),
  messages: z.array(AgentsUiConversationMessageSchema),
});

export const AgentsUiWorktreeConversationResponseSchema = z.object({
  worktree: AgentsUiWorktreeSummarySchema,
  conversation: AgentsUiConversationStateSchema,
});

export const AgentsUiSendMessageResponseSchema = z.object({
  conversationId: z.string(),
  turnId: z.string(),
  running: z.literal(true),
  streaming: z.boolean(),
});

export const AgentsUiInterruptResponseSchema = z.object({
  conversationId: z.string(),
  turnId: z.string(),
  interrupted: z.literal(true),
  streaming: z.boolean(),
});

export const AgentsUiConversationMessageDeltaEventSchema = z.object({
  type: z.literal('messageDelta'),
  revision: z.number().int().nonnegative(),
  conversationId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  order: z.number().int().nonnegative(),
  delta: z.string(),
});

export const AgentsUiConversationMessageUpsertEventSchema = z.object({
  type: z.literal('messageUpsert'),
  revision: z.number().int().nonnegative(),
  conversationId: z.string(),
  message: AgentsUiConversationMessageSchema,
});

export const AgentsUiConversationStatusEventSchema = z.object({
  type: z.literal('conversationStatus'),
  revision: z.number().int().nonnegative(),
  conversationId: z.string(),
  running: z.boolean(),
  activeTurnId: z.string().nullable(),
});

export const AgentsUiConversationErrorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});

export const AgentsUiConversationEventSchema = z.discriminatedUnion('type', [
  AgentsUiConversationMessageDeltaEventSchema,
  AgentsUiConversationMessageUpsertEventSchema,
  AgentsUiConversationStatusEventSchema,
  AgentsUiConversationErrorEventSchema,
]);

export const WorktreeListResponseSchema = z.object({
  worktrees: z.array(ProjectWorktreeSnapshotSchema),
});

export const UnpushedCommitSchema = z.object({
  hash: z.string(),
  message: z.string(),
});

export const WorktreeDiffResponseSchema = z.object({
  uncommitted: z.string(),
  uncommittedTruncated: z.boolean(),
  gitStatus: z.string(),
  unpushedCommits: z.array(UnpushedCommitSchema),
});

export const ServiceConfigSchema = z.object({
  name: z.string(),
  portEnv: z.string(),
});

export const ProfileConfigSchema = z.object({
  name: z.string(),
  systemPrompt: z.string().optional(),
});

export const LinkedRepoInfoSchema = z.object({
  alias: z.string(),
  dir: z.string().optional(),
});

export const AppConfigSchema = z.object({
  name: z.string(),
  services: z.array(ServiceConfigSchema),
  profiles: z.array(ProfileConfigSchema),
  agents: z.array(AgentSummarySchema),
  defaultProfileName: z.string(),
  defaultAgentId: BuiltInAgentIdSchema,
  autoName: z.boolean(),
  linearAvailability: z.enum(['disabled', 'missing_api_key', 'ready']),
  linearAutoCreateWorktrees: z.boolean(),
  startupEnvs: z.record(z.union([z.string(), z.boolean()])),
  linkedRepos: z.array(LinkedRepoInfoSchema),
  autoRemoveOnMerge: z.boolean(),
  projectDir: z.string(),
  mainBranch: z.string(),
});

export const CiLogsResponseSchema = z.object({
  logs: z.string(),
});

export const WorktreeNameParamsSchema = z.object({
  name: z.string(),
});

export const WorktreeTabParamsSchema = z.object({
  name: z.string(),
  tabId: z.string(),
});

export const CreateTabResponseSchema = z.object({
  tab: WorktreeTabSchema,
});

export const NotificationIdParamsSchema = z.object({
  id: NumberLikePathParamSchema,
});

export const AgentIdParamsSchema = z.object({
  id: AgentIdSchema,
});

export const RunIdParamsSchema = z.object({
  runId: NumberLikePathParamSchema,
});

/* ------------------------------------------------------------------------- *
 * Projects — the Issue Flow registry (§47), served by `src/web/projects-api.ts`
 * ------------------------------------------------------------------------- */

/**
 * One project as `GET /api/projects` returns it.
 *
 * Two fields the upstream's `ProjectSummary` has no equivalent for, and both
 * matter: `id` is the Issue Flow `projectId` (derived from the remote, never
 * from the path — §47.2), and `served` distinguishes "the registry knows this
 * project" from "this process is serving it right now". A registered project
 * with no active work is exactly the case that did not exist before §47, so
 * `prefix` is nullable.
 */
export const ProjectSummarySchema = z.object({
  id: z.string(),
  prefix: z.string().nullable(),
  name: z.string().nullable(),
  root: z.string(),
  source: z.string(),
  active: z.boolean(),
  served: z.boolean(),
  addedAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
});

export const ProjectsResponseSchema = z.object({
  projects: z.array(ProjectSummarySchema),
});

export const AddProjectRequestSchema = z.object({
  path: z.string().min(1),
});

/**
 * Adding a repository that still needs the convention scaffold kicks off an
 * async setup job; the response says the job started and the client polls
 * `projectInits`. An already-configured repository is registered immediately
 * and `project` comes back.
 */
export const AddProjectResponseSchema = z.object({
  initializing: z.boolean(),
  path: z.string(),
  project: ProjectSummarySchema.optional(),
});

export const ProjectInitPhaseSchema = z.enum([
  'creating_config',
  'analyzing',
  'ready',
  'failed',
]);

export const ProjectInitStateSchema = z.object({
  path: z.string(),
  phase: ProjectInitPhaseSchema,
  prefix: z.string().nullable(),
  name: z.string().nullable(),
  error: z.string().nullable(),
});

export const ProjectInitsResponseSchema = z.object({
  inits: z.array(ProjectInitStateSchema),
});

export const ProjectPrefixParamsSchema = z.object({
  prefix: z.string(),
});

export const RemoveProjectResponseSchema = z.object({
  ok: z.literal(true),
  prefix: z.string(),
  id: z.string(),
});

/* ------------------------------------------------------------------------- *
 * Executions — the Issue Flow half, served by `src/web/server.ts` today
 * ------------------------------------------------------------------------- */

/**
 * Every snapshot field can arrive as `undefined` (the version that wrote the
 * `session.json` did not have it) as well as `null` (present, not reported).
 * Both mean "not reported" and neither may reach the screen as `0` or `NaN`
 * — the dashboard's `metric()` helper is what enforces that, and this schema
 * is deliberately permissive so an old file still parses instead of being
 * rejected wholesale.
 */
export const SessionSummarySchema = z.object({
  sessionId: z.string().nullable().default(null),
  projectId: z.string().nullable().default(null),
  issueNumber: z.union([z.number(), z.string()]).nullable().default(null),
  issueTitle: z.string().nullable().default(null),
  issueDescription: z.string().nullable().default(null),
  repositoryName: z.string().nullable().default(null),
  currentPhase: z.string().nullable().default(null),
  progressPercent: z.number().nullable().default(null),
  elapsedSeconds: z.number().nullable().default(null),
  status: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
  retries: z.number().nullable().default(null),
  correctionCycle: z.number().nullable().default(null),
  attempt: z.number().nullable().default(null),
  provider: z.string().nullable().default(null),
  lastFailureKind: z.string().nullable().default(null),
  cooldownUntil: z.string().nullable().default(null),
  lastActivityAt: z.string().nullable().default(null),
  agentLifecycle: z.string().nullable().default(null),
  awaitingInputCount: z.number().nullable().default(null),
  /**
   * §32's escalation, decided by the pipeline and only displayed here.
   *
   * A card needs to tell "the agent just asked something" from "the agent asked
   * and nobody came" — the second is the one that has stopped making progress.
   * It is never computed in the browser: a headless run with no dashboard open
   * has to escalate too (ADR-03).
   */
  awaitingInputEscalatedAt: z.string().nullable().default(null),
  /**
   * A person is driving this run (§32). While it is set the watchdog is paused
   * and no phase advances, so the run looks idle and is not.
   */
  humanHold: z
    .object({ since: z.string(), reason: z.string() })
    .nullable()
    .default(null),
  statusUrl: z.string(),
  eventsUrl: z.string(),
});

export const SessionListResponseSchema = z.array(SessionSummarySchema);

/**
 * The reduced snapshot, passed through unvalidated on purpose.
 *
 * `sessionSnapshotSchema` in `packages/issue-flow/src/schemas.ts` is its
 * authority, it is versioned by the pipeline rather than by the dashboard, and
 * a monitor that refused to render a snapshot it could not fully parse would
 * be strictly worse than one that renders what it recognises. The dashboard
 * narrows what it reads, field by field, at the point of use.
 */
export const SessionSnapshotSchema = z.record(z.unknown());

export const JournalEntrySchema = z.object({
  seq: z.number(),
  event: z.record(z.unknown()),
});

export const JournalResponseSchema = z.array(JournalEntrySchema);

export const AgentEventSchema = z.record(z.unknown());
export const AgentEventsResponseSchema = z.array(AgentEventSchema);

export const DiagnosticsResponseSchema = z.array(z.record(z.unknown()));

export const HarnessCatalogEntrySchema = z.object({
  harness: z.string(),
  provider: z.string(),
  installed: z.boolean(),
  authenticated: z.boolean(),
  authentication: z.string(),
  state: z.string(),
  source: z.string(),
  observedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  detail: z.string().nullable(),
  models: z.array(z.unknown()),
});

export const EffectiveConfigResponseSchema = z.object({
  effective: z.record(z.unknown()).nullable(),
  capturedForSession: z.string().nullable(),
  routing: z.unknown(),
  catalog: z.array(HarnessCatalogEntrySchema),
  writable: z.boolean(),
  writeScope: z.string(),
});

export const ConfigWriteRequestSchema = z.record(z.unknown());

export const ConfigWriteResponseSchema = z.object({
  ok: z.boolean(),
  file: z.string().optional(),
  appliesTo: z.string().optional(),
});

/**
 * `GET /api/health`.
 *
 * `capabilities` is the only truthful signal about what this monitor can do:
 * the assets on screen may be newer than the process serving them (a run
 * reuses whatever instance already holds the lock), so the dashboard must
 * never infer a capability from a version number.
 */
export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  pid: z.number(),
  instanceId: z.string(),
  startedAt: z.string(),
  uptime: z.number(),
  version: z.string(),
  refreshSeconds: z.number(),
  capabilities: z.array(z.string()),
});

export const TerminalTokenResponseSchema = z.object({
  token: z.string(),
  path: z.string(),
});

export const SessionQuerySchema = z.object({
  session: z.string().optional(),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type OkResponse = z.infer<typeof OkResponseSchema>;
export type EnabledResponse = z.infer<typeof EnabledResponseSchema>;
export type BuiltInAgentId = z.infer<typeof BuiltInAgentIdSchema>;
export type AgentId = z.infer<typeof AgentIdSchema>;
export type AgentKind = z.infer<typeof AgentKindSchema>;
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
export type AgentDetails = z.infer<typeof AgentDetailsSchema>;
export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;
export type UpsertCustomAgentRequest = z.infer<typeof UpsertCustomAgentRequestSchema>;
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
export type ValidateCustomAgentResponse = z.infer<typeof ValidateCustomAgentResponseSchema>;
export type WorktreeCreateMode = z.infer<typeof WorktreeCreateModeSchema>;
export type OneshotConfig = z.infer<typeof OneshotConfigSchema>;
export type WorktreeCreationPhase = z.infer<typeof WorktreeCreationPhaseSchema>;
export type AvailableBranch = z.infer<typeof AvailableBranchSchema>;
// Kept manual so callers pass booleans instead of raw `"true"`/`"false"` literals.
export type AvailableBranchesQuery = { includeRemote?: boolean };
export type BranchListResponse = z.infer<typeof BranchListResponseSchema>;
export type CreateWorktreeRequest = z.infer<typeof CreateWorktreeRequestSchema>;
export type OpenWorktreeRequest = z.infer<typeof OpenWorktreeRequestSchema>;
export type WorktreeSource = z.infer<typeof WorktreeSourceSchema>;
export type CreateWorktreeResponse = z.infer<typeof CreateWorktreeResponseSchema>;
export type SetWorktreeArchivedRequest = z.infer<typeof SetWorktreeArchivedRequestSchema>;
export type SetWorktreeArchivedResponse = z.infer<typeof SetWorktreeArchivedResponseSchema>;
export type SetWorktreeLabelRequest = z.infer<typeof SetWorktreeLabelRequestSchema>;
export type SetWorktreeLabelResponse = z.infer<typeof SetWorktreeLabelResponseSchema>;
export type SetWorktreeProfileRequest = z.infer<typeof SetWorktreeProfileRequestSchema>;
export type SetWorktreeProfileResponse = z.infer<typeof SetWorktreeProfileResponseSchema>;
export type ToggleEnabledRequest = z.infer<typeof ToggleEnabledRequestSchema>;
export type SendWorktreePromptRequest = z.infer<typeof SendWorktreePromptRequestSchema>;
export type AgentsSendMessageRequest = z.infer<typeof AgentsSendMessageRequestSchema>;
export type PullMainRequest = z.infer<typeof PullMainRequestSchema>;
export type PullMainResult = z.infer<typeof PullMainResponseSchema>;
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;
export type PrComment = z.infer<typeof PrCommentSchema>;
export type CiCheck = z.infer<typeof CiCheckSchema>;
export type PrEntry = z.infer<typeof PrEntrySchema>;
export type AutoNameConfigResponse = z.infer<typeof AutoNameConfigResponseSchema>;
export type LinearIssue = z.infer<typeof LinearIssueSchema>;
export type LinearIssueAvailability = z.infer<typeof LinearIssuesResponseSchema>['availability'];
export type LinearIssuesResponse = z.infer<typeof LinearIssuesResponseSchema>;
export type LinearTarget = z.infer<typeof LinearTargetSchema>;
export type PostWorktreeToLinearRequest = z.infer<typeof PostWorktreeToLinearRequestSchema>;
export type PostWorktreeToLinearResponse = z.infer<typeof PostWorktreeToLinearResponseSchema>;
export type WorktreeCreationState = z.infer<typeof WorktreeCreationStateSchema>;
export type AppNotification = z.infer<typeof AppNotificationSchema>;
export type ProjectWorktreeSnapshot = z.infer<typeof ProjectWorktreeSnapshotSchema>;
export type WorktreeTab = z.infer<typeof WorktreeTabSchema>;
export type WorktreeTabParams = z.infer<typeof WorktreeTabParamsSchema>;
export type CreateTabResponse = z.infer<typeof CreateTabResponseSchema>;
export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;
export type WorktreeConversationProvider = z.infer<typeof WorktreeConversationProviderSchema>;
export type CodexWorktreeConversationRef = z.infer<typeof CodexWorktreeConversationRefSchema>;
export type ClaudeWorktreeConversationRef = z.infer<typeof ClaudeWorktreeConversationRefSchema>;
export type WorktreeConversationRef = z.infer<typeof WorktreeConversationRefSchema>;
export type AgentsUiWorktreeSummary = z.infer<typeof AgentsUiWorktreeSummarySchema>;
export type AgentsUiConversationMessageRole = z.infer<typeof AgentsUiConversationMessageRoleSchema>;
export type AgentsUiConversationMessageStatus = z.infer<
  typeof AgentsUiConversationMessageStatusSchema
>;
export type AgentsUiConversationMessageKind = z.infer<typeof AgentsUiConversationMessageKindSchema>;
export type AgentsUiConversationMessage = z.infer<typeof AgentsUiConversationMessageSchema>;
export type AgentsUiConversationState = z.infer<typeof AgentsUiConversationStateSchema>;
export type AgentsUiWorktreeConversationResponse = z.infer<
  typeof AgentsUiWorktreeConversationResponseSchema
>;
export type AgentsUiSendMessageResponse = z.infer<typeof AgentsUiSendMessageResponseSchema>;
export type AgentsUiInterruptResponse = z.infer<typeof AgentsUiInterruptResponseSchema>;
export type AgentsUiConversationMessageDeltaEvent = z.infer<
  typeof AgentsUiConversationMessageDeltaEventSchema
>;
export type AgentsUiConversationMessageUpsertEvent = z.infer<
  typeof AgentsUiConversationMessageUpsertEventSchema
>;
export type AgentsUiConversationStatusEvent = z.infer<typeof AgentsUiConversationStatusEventSchema>;
export type AgentsUiConversationErrorEvent = z.infer<typeof AgentsUiConversationErrorEventSchema>;
export type AgentsUiConversationEvent = z.infer<typeof AgentsUiConversationEventSchema>;
export type WorktreeListResponse = z.infer<typeof WorktreeListResponseSchema>;
export type UnpushedCommit = z.infer<typeof UnpushedCommitSchema>;
export type WorktreeDiffResponse = z.infer<typeof WorktreeDiffResponseSchema>;
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type ProfileConfig = z.infer<typeof ProfileConfigSchema>;
export type LinkedRepoInfo = z.infer<typeof LinkedRepoInfoSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
export type CiLogsResponse = z.infer<typeof CiLogsResponseSchema>;
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type ProjectsResponse = z.infer<typeof ProjectsResponseSchema>;
export type AddProjectRequest = z.infer<typeof AddProjectRequestSchema>;
export type AddProjectResponse = z.infer<typeof AddProjectResponseSchema>;
export type ProjectInitPhase = z.infer<typeof ProjectInitPhaseSchema>;
export type ProjectInitState = z.infer<typeof ProjectInitStateSchema>;
export type ProjectInitsResponse = z.infer<typeof ProjectInitsResponseSchema>;
export type RemoveProjectResponse = z.infer<typeof RemoveProjectResponseSchema>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
export type JournalEntry = z.infer<typeof JournalEntrySchema>;
export type JournalResponse = z.infer<typeof JournalResponseSchema>;
export type AgentEventsResponse = z.infer<typeof AgentEventsResponseSchema>;
export type DiagnosticsResponse = z.infer<typeof DiagnosticsResponseSchema>;
export type HarnessCatalogEntry = z.infer<typeof HarnessCatalogEntrySchema>;
export type EffectiveConfigResponse = z.infer<typeof EffectiveConfigResponseSchema>;
export type ConfigWriteResponse = z.infer<typeof ConfigWriteResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type TerminalTokenResponse = z.infer<typeof TerminalTokenResponseSchema>;
