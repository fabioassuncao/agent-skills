/**
 * The agent layer: a swappable runner inside `runHeadless` / `executeClaude`.
 *
 * The pipeline still talks to those two facades. What changes is the binary
 * they spawn and how its stream is read. Defaults stay Claude, and an
 * unconfigured invocation produces the same argv the project has always used.
 */

import type { ClaudeUsage } from '../core/metrics.js';

/** Providers the pipeline can invoke. A fourth (#80) adds a file, not a refactor. */
export type AgentProviderId = 'claude' | 'codex' | 'cursor';

/** The eight invocations that actually call an agent. `init` is not one of them. */
export type AgentPhase =
  | 'analyze'
  | 'generate'
  | 'prd'
  | 'plan'
  | 'execute'
  | 'review'
  | 'pr'
  | 'pr-review';

export const AGENT_PHASES: readonly AgentPhase[] = [
  'analyze',
  'generate',
  'prd',
  'plan',
  'execute',
  'review',
  'pr',
  'pr-review',
] as const;

export function isAgentPhase(value: string): value is AgentPhase {
  return (AGENT_PHASES as readonly string[]).includes(value);
}

export function isAgentProviderId(value: string): value is AgentProviderId {
  return value === 'claude' || value === 'codex' || value === 'cursor';
}

/**
 * Semantic permission of an invocation, translated by each runner.
 *
 *   read-only  — phases that only inspect (analyze, review, pr-review)
 *   workspace  — phases that write artifacts (generate, prd, plan, pr)
 *   autonomous — the execute loop
 */
export type AgentPermission = 'read-only' | 'workspace' | 'autonomous';

/** Default permission of each phase. Analyze writes `analysis.md` via a
 * fallback when the agent cannot write, so it stays in the issue's read-only
 * set: the agent is asked not to mutate the project, and the command writes
 * the artifact itself when needed. */
export const DEFAULT_PHASE_PERMISSION: Record<AgentPhase, AgentPermission> = {
  analyze: 'read-only',
  generate: 'workspace',
  prd: 'workspace',
  plan: 'workspace',
  execute: 'autonomous',
  review: 'read-only',
  pr: 'workspace',
  'pr-review': 'read-only',
};

/** Token/cost metrics. Alias of the existing Claude shape so no import breaks. */
export type AgentUsage = ClaudeUsage;

export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail?: string };

/**
 * What a runner needs to execute one invocation.
 *
 * `onLine` is the watchdog heartbeat: a process writing anything is a process
 * that is alive, including a malformed line. `onEvent` is the normalised
 * stream the UI already consumes.
 */
export interface AgentInvocation {
  prompt: string;
  phase: AgentPhase;
  workingDirectory?: string;
  addDirs?: string[];
  /** ms; 0 = no limit (the execute loop). */
  timeout: number;
  permission: AgentPermission;
  maxTurns?: number;
  allowedTools?: string[];
  onEvent?: (event: AgentEvent) => void;
  onLine?: (line: string) => void;
  /**
   * Silence tolerated before the agent is considered stuck. Absent or `0`
   * disables the watchdog — verbose headless never had one.
   */
  inactivityTimeoutMs?: number;
  /** Pin this invocation to a provider (L2 reviewer). Skips failover. */
  forceProvider?: AgentProviderId;
  /** Telemetry purpose when it is not the phase name (`verify`). */
  purpose?: 'verify';
}

export interface AgentRunResult {
  success: boolean;
  result: string;
  /** Combined raw output, for `isTransientFailure()` / `trimErrorMessage()`. */
  rawOutput: string;
  exitCode: number;
  usage: AgentUsage | null;
  error: string | null;
  /** Who actually ran — never inferred afterwards. */
  agent: { provider: AgentProviderId; model: string | null };
  sessionId?: string;
  /** Captured at invocation time and cached per process. */
  harnessVersion?: string | null;
}

/**
 * What a runner can do. Declared so a fourth provider adds a file, not a
 * refactor. The core asks "does this invocation need extraDirectories?",
 * never "which provider is this?".
 */
export interface AgentCapabilities {
  /** Extra directories beyond the workspace. `flag` is `--add-dir`. */
  extraDirectories: 'flag' | 'permission-file' | 'none';
  /** Convenience: `extraDirectories === 'flag'`. */
  addDirs: boolean;
  toolAllowlist: boolean;
  maxTurns: boolean;
  osSandbox: boolean;
  modelSelection: boolean;
  modelDiscovery: boolean;
  usage: 'tokens-and-cost' | 'tokens-only' | 'none';
  reportsUsage: boolean;
  reportsCost: boolean;
  sessionResume: boolean;
  /** How the auth probe is interpreted. Cursor's `status` exits 0 while logged out. */
  authProbe: 'exit-code' | 'text' | 'none';
  bareModelAliases: boolean;
  promptChannel: 'argv' | 'stdin' | 'both';
  nativeTimeout: boolean;
  contextFileName: string;
  contextFileMaxBytes: number | null;
  toolNameCase: 'CamelCase' | 'lowercase' | 'none';
  readOnlyMode: 'native' | 'sandbox' | 'tool-allowlist' | 'none';
}

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ClaudeSettings {
  ignoreUserConfig?: boolean;
}

export interface CodexSettings {
  reasoningEffort?: CodexReasoningEffort;
  sandbox?: CodexSandbox;
  ignoreUserConfig?: boolean;
  skipGitRepoCheck?: boolean;
  configOverrides?: Record<string, string | number | boolean>;
}

export type CursorSandbox = 'enabled' | 'disabled';
export type CursorPermissionsFile = 'global' | 'project' | 'none';

export interface CursorSettings {
  sandbox?: CursorSandbox;
  approveMcps?: boolean;
  permissionsFile?: CursorPermissionsFile;
  minVersion?: string;
}

/** One layer of the agent block — default or a single phase. */
export interface AgentBlock {
  provider?: AgentProviderId;
  model?: string | null;
  claude?: ClaudeSettings;
  codex?: CodexSettings;
  cursor?: CursorSettings;
}

export interface AgentConfig {
  provider: AgentProviderId;
  model: string | null;
  claude: ClaudeSettings;
  codex: CodexSettings;
  cursor: CursorSettings;
  phases: Partial<Record<AgentPhase, AgentBlock>>;
}

/** Which rung of the ladder produced a resolved value. */
export type AgentOrigin = 'default' | 'global' | 'project' | 'env' | 'cli';

export interface ResolvedAgentSettings {
  provider: AgentProviderId;
  model: string | null;
  claude: ClaudeSettings;
  codex: CodexSettings;
  cursor: CursorSettings;
  origin: {
    provider: AgentOrigin;
    model: AgentOrigin;
  };
}

export interface AgentRunner {
  readonly id: AgentProviderId;
  readonly capabilities: AgentCapabilities;
  versionCommand(): { command: string; args: string[] };
  authCommand?(): { command: string; args: string[] };
  run(invocation: AgentInvocation, settings: ResolvedAgentSettings): Promise<AgentRunResult>;
}

export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  extraDirectories: 'flag',
  addDirs: true,
  toolAllowlist: true,
  maxTurns: true,
  osSandbox: false,
  modelSelection: true,
  modelDiscovery: false,
  usage: 'tokens-and-cost',
  reportsUsage: true,
  reportsCost: true,
  sessionResume: false,
  authProbe: 'none',
  bareModelAliases: true,
  promptChannel: 'both',
  nativeTimeout: false,
  contextFileName: 'CLAUDE.md',
  contextFileMaxBytes: null,
  toolNameCase: 'CamelCase',
  readOnlyMode: 'native',
};

export const CODEX_CAPABILITIES: AgentCapabilities = {
  extraDirectories: 'flag',
  addDirs: true,
  toolAllowlist: false,
  maxTurns: false,
  osSandbox: true,
  modelSelection: true,
  modelDiscovery: false,
  usage: 'tokens-only',
  reportsUsage: true,
  reportsCost: false,
  sessionResume: true,
  authProbe: 'exit-code',
  bareModelAliases: false,
  promptChannel: 'both',
  nativeTimeout: false,
  contextFileName: 'AGENTS.md',
  contextFileMaxBytes: 32 * 1024,
  toolNameCase: 'none',
  readOnlyMode: 'sandbox',
};

export const CURSOR_CAPABILITIES: AgentCapabilities = {
  extraDirectories: 'permission-file',
  addDirs: false,
  toolAllowlist: false,
  maxTurns: false,
  osSandbox: true,
  modelSelection: true,
  modelDiscovery: true,
  usage: 'none',
  reportsUsage: false,
  reportsCost: false,
  sessionResume: true,
  authProbe: 'text',
  bareModelAliases: false,
  promptChannel: 'argv',
  nativeTimeout: false,
  contextFileName: 'AGENTS.md',
  contextFileMaxBytes: null,
  toolNameCase: 'lowercase',
  readOnlyMode: 'native',
};

export const AGENT_SCHEMA_VERSION = 1;

/**
 * CLI overrides captured by `setAgentCliOverrides`.
 *
 * `forceProvider` / `forceModel` are the emergency buttons (`--agent` /
 * `--agent-model`): they overwrite every phase after the ladder has run.
 */
export interface AgentCliOverrides {
  provider?: AgentProviderId;
  model?: string | null;
  forceProvider?: AgentProviderId;
  forceModel?: string;
  claude?: ClaudeSettings;
  codex?: CodexSettings;
  cursor?: CursorSettings;
  phases?: Partial<Record<AgentPhase, AgentBlock>>;
}
