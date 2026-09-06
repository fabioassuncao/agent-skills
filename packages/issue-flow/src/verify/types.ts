export type VerdictStatus = 'passed' | 'failed' | 'unverified';

export const VERIFICATION_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L5'] as const;

export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

export type CheckStatus = 'passed' | 'failed' | 'skipped' | 'could-not-run';

export interface AcceptanceCheck {
  id: string;
  run?: string;
  expectFiles?: string[];
  /** A declared check is fatal unless it says otherwise. Defaults to `true`. */
  fatal?: boolean;
}

export interface AcceptanceContract {
  checks: AcceptanceCheck[];
  source: 'declared' | 'discovered' | 'empty';
}

export interface CheckResult {
  id: string;
  command: string | null;
  status: CheckStatus;
  fatal: boolean;
  durationMs: number;
  exitCode: number | null;
  output: string;
}

export interface ContractRun {
  verdict: VerdictStatus;
  results: CheckResult[];
  level: VerificationLevel;
}

export interface VerifyLevelInput {
  requested?: VerificationLevel | null;
  /** Configured triggers that fire L2. Empty means L2 stays off. */
  triggers?: readonly string[];
  signals?: readonly string[];
  explicit?: boolean;
  crossVerify?: boolean;
}

export type Independence = 'harness-and-vendor' | 'harness-only' | 'vendor-only' | 'none';

export interface ReviewerSelection {
  provider: string | null;
  independence: Independence;
  degraded: boolean;
  reason: string;
}
