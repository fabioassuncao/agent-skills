import type { FailureKind } from '../resilience/errors.js';

export const EXECUTION_PURPOSES = [
  'analyze',
  'generate',
  'prd',
  'plan',
  'execute',
  'review',
  'pr',
  'pr-review',
  'verify',
] as const;

export type ExecutionPurpose = (typeof EXECUTION_PURPOSES)[number];

export type ExecutionTrigger = 'initial' | 'retry' | 'fallback' | 'correction' | 'escalation';

export type ExecutionStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'interrupted';

export type StopReason =
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'max_attempts'
  | 'max_cost'
  | 'max_duration';

export type VerdictStatus = 'passed' | 'failed' | 'unverified';

export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  details?: Record<string, number>;
  source: 'provider' | 'unavailable';
}

export interface PricingSnapshot {
  tableVersion: string;
  modelKey: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  capturedAt: string;
}

export type CostRecord =
  | { status: 'reported'; amount: number; currency: 'USD' }
  | { status: 'estimated'; amount: number; currency: 'USD'; pricing: PricingSnapshot }
  | {
      status: 'unknown';
      reason: 'not_reported' | 'no_pricing' | 'unknown_model' | 'subscription' | 'zero_rated';
    };

export interface ExecutionAgent {
  harness: string;
  provider: string | null;
  harnessVersion?: string | null;
  model: {
    requested: string | null;
    resolved: string | null;
    source: 'provider' | 'config' | 'unavailable';
  };
  providerSessionId: string | null;
}

export interface ExecutionOwner {
  pid: number;
  host: string;
}

export interface ExecutionVerdict {
  status: VerdictStatus;
  level?: string | null;
  independence?: string | null;
}

export interface RoutingDecision {
  selected: string;
  actual?: string;
  candidates?: unknown[];
  reasonCodes?: string[];
  [key: string]: unknown;
}

export interface ExecutionRecord {
  id: string;
  sessionId: string | null;
  purpose: ExecutionPurpose;
  attempt: number;
  trigger: ExecutionTrigger;
  triggerReason: FailureKind | null;
  agent: ExecutionAgent;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** Envelope duration when the CLI reports it. */
  cliDurationMs?: number | null;
  /** wallClock − cliDuration: startup the CLI does not see. */
  harnessStartupMs?: number | null;
  /** Envelope `duration_api_ms` when reported. */
  apiDurationMs?: number | null;
  /** Time to first output, when reported. */
  ttftMs?: number | null;
  numTurns?: number | null;
  usage: NormalizedUsage | null;
  cost: CostRecord;
  status: ExecutionStatus;
  failure: {
    kind: FailureKind;
    message: string;
    exitCode: number | null;
  } | null;
  stopReason?: StopReason | null;
  iteration?: number;
  storyIds?: string[];
  owner?: ExecutionOwner | null;
  routingDecision?: RoutingDecision | null;
  verdict?: ExecutionVerdict | null;
}

export interface CostTotals {
  reported: number;
  estimated: number;
  unknownExecutions: number;
}

export interface ExecutionSummary {
  count: number;
  discarded: number;
  byStatus: Partial<Record<ExecutionStatus, number>>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    reasoningTokens: number;
  };
  totalCost: CostTotals;
}

export interface TelemetryConfig {
  enabled: boolean;
  maxExecutions: number;
  pricing: {
    estimate: boolean;
    overrides: Record<string, Partial<PricingSnapshot>>;
  };
}

export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
  maxExecutions: 500,
  pricing: { estimate: false, overrides: {} },
};
