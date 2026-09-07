import type {
  AgentId,
  PrEntry,
  ServiceStatus,
  WorktreeCreationPhase,
  WorktreeSource,
  WorktreeTab,
} from '@issue-flow/contract';

/** Types shared by dashboard components. */

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
  AgentsUiConversationMessage,
  AgentsUiConversationState,
  AgentsUiInterruptResponse,
  AgentsUiSendMessageResponse,
  AgentsUiWorktreeConversationResponse,
  AppConfig,
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
  PostWorktreeToLinearRequest,
  PostWorktreeToLinearResponse,
  PrComment,
  PrEntry,
  ProfileConfig,
  ProjectInitPhase,
  ProjectInitState,
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

export type ToastItem = UiToastItem;
