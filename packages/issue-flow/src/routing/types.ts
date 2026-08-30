export type TaskClass = 'bugfix' | 'feature' | 'refactor' | 'docs' | 'test' | 'infra' | 'analysis';

export type RiskLevel = 'low' | 'medium' | 'high';

export type RoutingProfile = 'economy' | 'balanced' | 'quality' | 'speed';

export type RoutingMode = 'off' | 'shadow' | 'recommend' | 'active';

export interface TaskSignals {
  title?: string;
  labels?: readonly string[];
  paths?: readonly string[];
  body?: string;
}

export interface ExecutionTarget {
  harness: string;
  provider: string;
  model?: string | null;
}

export interface Candidate {
  harness: string;
  provider: string;
  model?: string | null;
  eligible: boolean;
  prior: number;
  learned: number;
  samples: number;
  score: number;
  reasonCodes: string[];
}

export interface RoutingDecision {
  policyVersion: string;
  profile: RoutingProfile;
  taskClass: TaskClass;
  risk: RiskLevel;
  mode: RoutingMode;
  candidates: Candidate[];
  selected: string;
  actual: string;
  reasonCodes: string[];
}

export const REASON_CODES = [
  'HIGH_PRIOR',
  'HIGH_HISTORICAL_SUCCESS',
  'LOWER_EXPECTED_LATENCY',
  'MISSING_CAPABILITY',
  'PROVIDER_UNAVAILABLE',
  'EXPLICIT_CONFIG',
  'TIE_BREAK',
  'COLD_START',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];
