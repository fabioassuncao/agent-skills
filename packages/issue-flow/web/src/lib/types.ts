import type {
  AgentId,
  OneshotConfig,
  PrEntry,
  ServiceStatus,
  WorktreeCreationPhase,
  WorktreeSource,
  WorktreeTab,
} from '@issue-flow/contract';

/**
 * PORT of `frontend/src/lib/types.ts` @ d8c9d5f (160 lines).
 *
 * Types and interfaces only — no runtime logic, as upstream. The re-export list
 * omits the migration sensor (`InstanceSummary`, §48.1) and includes the
 * environment-authenticated Linear surface, plus the Issue Flow contract.
 */

export type {
  AgentCapabilities,
  AgentDetails,
  AgentEventsResponse,
  AgentId,
  AgentKind,
  AgentListResponse,
  AgentResponse,
  AgentSummary,
  AgentsSendMessageRequest as AgentsUiSendMessageRequest,
  AgentsUiConversationEvent,
  AgentsUiConversationMessage,
  AgentsUiConversationMessageDeltaEvent,
  AgentsUiConversationMessageUpsertEvent,
  AgentsUiConversationState,
  AgentsUiConversationStatusEvent,
  AgentsUiInterruptResponse,
  AgentsUiSendMessageResponse,
  AgentsUiWorktreeConversationResponse,
  AppConfig,
  AppNotification,
  AvailableBranch,
  AvailableBranchesQuery,
  BranchListResponse,
  BuiltInAgentId,
  CapabilityName,
  CiCheck,
  ConfigWriteResponse,
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  DiagnosticsResponse,
  EffectiveConfigResponse,
  HarnessCatalogEntry,
  HealthResponse,
  JournalEntry,
  JournalResponse,
  LinearIssue,
  LinearIssueAvailability,
  LinearIssuesResponse,
  LinkedRepoInfo,
  OneshotConfig,
  PostWorktreeToLinearRequest,
  PostWorktreeToLinearResponse,
  PrComment,
  PrEntry,
  ProfileConfig,
  ProjectInitPhase,
  ProjectInitState,
  ProjectSnapshot,
  ProjectSummary,
  ProjectWorktreeSnapshot,
  PullMainResult,
  ServiceConfig,
  ServiceStatus,
  SessionSnapshot,
  SessionSummary,
  SetWorktreeArchivedRequest,
  SetWorktreeArchivedResponse,
  SetWorktreeLabelRequest,
  SetWorktreeLabelResponse,
  TerminalTokenResponse,
  UnpushedCommit,
  UpsertCustomAgentRequest,
  ValidateCustomAgentResponse,
  WorktreeCreateMode,
  WorktreeCreationPhase,
  WorktreeCreationState,
  WorktreeDiffResponse,
  WorktreeListResponse,
  WorktreeSource,
  WorktreeTab,
} from '@issue-flow/contract';

export interface FileUploadResult {
  files: Array<{ path: string }>;
}

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionItem {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: AskUserQuestionOption[];
}

export interface AskUserQuestionInput {
  questions: AskUserQuestionItem[];
}

export interface DiffDialogProps {
  branch: string;
  cursorUrl?: string | null;
  onclose: () => void;
}

/**
 * One row of the sidebar.
 *
 * `executionId` and `issueRef` are the Issue Flow additions (§48.3): the same
 * row can be a free session (both null — ADR-16) or the workspace of a workflow
 * execution, and the sidebar says which without a second list.
 */
export interface WorktreeInfo {
  branch: string;
  label: string | null;
  baseBranch?: string;
  archived: boolean;
  agent: string;
  mux: string;
  path: string;
  dir: string | null;
  dirty: boolean;
  unpushed: boolean;
  status: string;
  elapsed: string;
  profile: string | null;
  agentName: AgentId | null;
  agentLabel: string | null;
  agentTerminalStale: boolean;
  services: ServiceStatus[];
  paneCount: number;
  prs: PrEntry[];
  creating: boolean;
  creationPhase: WorktreeCreationPhase | null;
  source: WorktreeSource;
  oneshot: OneshotConfig | null;
  tabs: WorktreeTab[];
  activeTabId: string | null;
  supportsTabs: boolean;
  executionId: string | null;
  issueRef: string | null;
  /** Assigned Linear issue inferred from the canonical issue branch name. */
  linearIssue?: import('@issue-flow/contract').LinearIssue | null;
}

export interface WorktreeListRow {
  worktree: WorktreeInfo;
  depth: number;
}

/**
 * One agent session as the consolidated "Trabalho ativo" view sees it (§49.4).
 *
 * A *sessão* — a live agent in a worktree — never an *execução* (ADR-20).
 * `runId` is what tells the two modes of §49 apart, and `free` says it in one
 * field so no client has to re-derive it from three nulls.
 */
export interface AgentSessionRow {
  id: string;
  projectId: string | null;
  branch: string;
  provider: string;
  label: string | null;
  status: string;
  runId: string | null;
  free: boolean;
}

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastInput {
  tone: ToastTone;
  message: string;
  detail?: string;
}

export interface UiToastItem extends ToastInput {
  id: string;
  source: 'ui';
}

export interface NotificationToastItem extends ToastInput {
  id: string;
  source: 'notification';
  notificationId: number;
  branch: string;
}

export type ToastItem = UiToastItem | NotificationToastItem;
