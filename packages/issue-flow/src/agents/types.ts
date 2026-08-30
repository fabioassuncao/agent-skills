/**
 * The agent layer: a swappable runner inside `runHeadless` / `executeClaude`.
 *
 * The pipeline still talks to those two facades. What changes is the binary
 * they spawn and how its stream is read. Defaults stay Claude, and an
 * unconfigured invocation produces the same argv the project has always used.
 */

import type { ClaudeUsage } from '../core/metrics.js';

/** The two providers this issue delivers. A third (#76) adds a file, not a refactor. */
export type AgentProviderId = 'claude' | 'codex';

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
  return value === 'claude' || value === 'codex';
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
 * What a runner can do. Declared so #76 (Cursor) and #80 (Antigravity) add a
 * file instead of refactoring the contract.
 */
export interface AgentCapabilities {
  addDirs: boolean;
  reportsUsage: boolean;
  reportsCost: boolean;
  /** How the auth probe is interpreted. Cursor's `status` exits 0 while logged out. */
  authProbe: 'exit-code' | 'text' | 'none';
  bareModelAliases: boolean;
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

/** One layer of the agent block — default or a single phase. */
export interface AgentBlock {
  provider?: AgentProviderId;
  model?: string | null;
  claude?: ClaudeSettings;
  codex?: CodexSettings;
}

export interface AgentConfig {
  provider: AgentProviderId;
  model: string | null;
  claude: ClaudeSettings;
  codex: CodexSettings;
  phases: Partial<Record<AgentPhase, AgentBlock>>;
}

/** Which rung of the ladder produced a resolved value. */
export type AgentOrigin = 'default' | 'global' | 'project' | 'env' | 'cli';

export interface ResolvedAgentSettings {
  provider: AgentProviderId;
  model: string | null;
  claude: ClaudeSettings;
  codex: CodexSettings;
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
  addDirs: true,
  reportsUsage: true,
  reportsCost: true,
  authProbe: 'none',
  bareModelAliases: true,
};

export const CODEX_CAPABILITIES: AgentCapabilities = {
  addDirs: true,
  reportsUsage: true,
  reportsCost: false,
  authProbe: 'exit-code',
  bareModelAliases: false,
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
  phases?: Partial<Record<AgentPhase, AgentBlock>>;
}
