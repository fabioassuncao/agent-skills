import type { PipelineState } from '../types.js';

/** Methodology shared at build time; sessions and delivery choices remain consumer-owned. */
export const WORKFLOW_PHASES = [
  { phase: 'prd', field: 'prdCompleted', requires: 'Available demand', produces: 'PRD exists' },
  {
    phase: 'plan',
    field: 'jsonCompleted',
    requires: 'PRD exists',
    produces: 'Valid task plan and dependency graph',
  },
  {
    phase: 'execute',
    field: 'executionCompleted',
    requires: 'Valid plan; eligible stories or pending findings',
    produces: 'Verified stories; no unresolved findings',
  },
  {
    phase: 'review',
    field: 'reviewCompleted',
    requires: 'Implementation available',
    produces: 'Valid PASS with acceptance evidence',
  },
  {
    phase: 'pr',
    field: 'prCreated',
    requires: 'Review passed; PR delivery authorized',
    produces: 'Confirmed pull request',
  },
  {
    phase: 'pr-review',
    field: 'prReviewCompleted',
    requires: 'Confirmed PR; review requested',
    produces: 'Valid approving review',
  },
] as const satisfies readonly {
  phase: string;
  field: keyof PipelineState;
  requires: string;
  produces: string;
}[];

export const DEFAULT_MAX_CORRECTION_CYCLES = 3;
export const DEFAULT_PIPELINE_STATE = {
  prdCompleted: false,
  jsonCompleted: false,
  executionCompleted: false,
  reviewCompleted: false,
  prCreated: false,
} satisfies PipelineState;

export function executionCompletion<
  T extends { issueStatus: string; completedAt: string | null; pipeline: PipelineState },
>(plan: T, inPipeline: boolean): T {
  return {
    ...plan,
    ...(inPipeline ? { issueStatus: 'in_progress', completedAt: null } : {}),
    pipeline: { ...plan.pipeline, executionCompleted: true },
  };
}
