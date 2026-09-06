import type { AgentPhase } from '../agents/types.js';
import type { ModelEntry, ModelTier } from './models.js';
import type { RiskLevel, RoutingProfile, TaskClass } from './types.js';

/** Bump when a role, phase default or ladder step changes. */
export const OPENCODE_GO_POLICY_VERSION = '1';

export const OPENCODE_GO_MODELS = {
  cheap: 'opencode-go/mimo-v2.5',
  default: 'opencode-go/qwen3.8-flash',
  codingCheap: 'opencode-go/deepseek-v4-flash',
  escalate: 'opencode-go/gpt-5.6-luna',
  specialist: 'opencode-go/kimi-k2.7-code',
} as const;

export type OpenCodeGoRole = 'cheap' | 'default' | 'coding-cheap' | 'escalate' | 'specialist';

/**
 * Main climb only. DeepSeek is a lateral coding-cheap step: it escalates
 * to Qwen, never to MiMo.
 */
export const OPENCODE_GO_LADDER: readonly string[] = [
  OPENCODE_GO_MODELS.cheap,
  OPENCODE_GO_MODELS.default,
  OPENCODE_GO_MODELS.escalate,
  OPENCODE_GO_MODELS.specialist,
];

const ROLE_BY_MODEL: Record<string, OpenCodeGoRole> = {
  [OPENCODE_GO_MODELS.cheap]: 'cheap',
  [OPENCODE_GO_MODELS.default]: 'default',
  [OPENCODE_GO_MODELS.codingCheap]: 'coding-cheap',
  [OPENCODE_GO_MODELS.escalate]: 'escalate',
  [OPENCODE_GO_MODELS.specialist]: 'specialist',
};

const TIER_BY_ROLE: Record<OpenCodeGoRole, ModelTier> = {
  cheap: 'fast',
  default: 'mid',
  'coding-cheap': 'mid',
  escalate: 'strong',
  specialist: 'strong',
};

const COST_BY_ROLE: Record<OpenCodeGoRole, { relativeCost: number; relativeLatency: number }> = {
  cheap: { relativeCost: 1, relativeLatency: 1 },
  default: { relativeCost: 2.5, relativeLatency: 1.3 },
  'coding-cheap': { relativeCost: 1.8, relativeLatency: 1.15 },
  escalate: { relativeCost: 5, relativeLatency: 1.8 },
  specialist: { relativeCost: 7, relativeLatency: 2 },
};

export interface OpenCodeGoInput {
  phase: AgentPhase;
  taskClass?: TaskClass;
  risk?: RiskLevel;
  profile?: RoutingProfile;
  correctionCycle?: number;
}

export interface OpenCodeGoChoice {
  model: string;
  role: OpenCodeGoRole;
  reasonCodes: string[];
}

export function isOpenCodeGoModel(model: string | null | undefined): boolean {
  return model !== null && model !== undefined && ROLE_BY_MODEL[model] !== undefined;
}

function choice(role: OpenCodeGoRole, reasonCodes: string[]): OpenCodeGoChoice {
  return {
    model: OPENCODE_GO_MODELS[role === 'coding-cheap' ? 'codingCheap' : role],
    role,
    reasonCodes,
  };
}

function phaseDefault(phase: AgentPhase): OpenCodeGoRole {
  if (phase === 'analyze') return 'cheap';
  if (phase === 'pr-review') return 'escalate';
  return 'default';
}

function correctionRole(cycle: number): OpenCodeGoRole {
  if (cycle <= 1) return 'coding-cheap';
  if (cycle === 2) return 'default';
  if (cycle === 3) return 'escalate';
  return 'specialist';
}

/**
 * Intra-OpenCode model for a phase. Kimi is never a first pick — only
 * `nextOpenCodeGoModel` or correction cycle ≥ 4 reach it.
 */
export function resolveOpenCodeGoModel(input: OpenCodeGoInput): OpenCodeGoChoice {
  const reasons = ['OPENCODE_GO_POLICY'];
  if ((input.correctionCycle ?? 0) >= 1 && input.phase === 'execute') {
    const role = correctionRole(input.correctionCycle ?? 1);
    if (role === 'specialist') reasons.push('OPENCODE_GO_SPECIALIST');
    else if (role === 'escalate') reasons.push('OPENCODE_GO_ESCALATE');
    else if (role === 'coding-cheap') reasons.push('OPENCODE_GO_CODING_CHEAP');
    return choice(role, reasons);
  }

  const taskClass = input.taskClass ?? 'feature';
  const risk = input.risk ?? 'low';
  let role = phaseDefault(input.phase);

  if (input.phase === 'analyze' && risk === 'high') {
    role = 'default';
  } else if (input.phase === 'generate' && taskClass === 'docs') {
    role = 'cheap';
    reasons.push('OPENCODE_GO_CHEAP');
  } else if (input.phase === 'prd' && (risk === 'high' || taskClass === 'infra')) {
    role = 'escalate';
    reasons.push('OPENCODE_GO_ESCALATE');
  } else if (input.phase === 'plan' && risk === 'high') {
    role = 'escalate';
    reasons.push('OPENCODE_GO_ESCALATE');
  } else if (input.phase === 'plan' && input.profile === 'economy' && risk === 'low') {
    role = 'cheap';
    reasons.push('OPENCODE_GO_CHEAP');
  } else if (input.phase === 'execute') {
    if (risk === 'high' || taskClass === 'infra' || (taskClass === 'refactor' && risk !== 'low')) {
      role = 'escalate';
      reasons.push('OPENCODE_GO_ESCALATE');
    } else if ((taskClass === 'bugfix' || taskClass === 'test') && risk === 'low') {
      role = 'coding-cheap';
      reasons.push('OPENCODE_GO_CODING_CHEAP');
    }
  } else if (input.phase === 'review' && risk === 'high') {
    role = 'escalate';
    reasons.push('OPENCODE_GO_ESCALATE');
  } else if (input.phase === 'pr' && taskClass === 'bugfix' && risk === 'low') {
    role = 'coding-cheap';
    reasons.push('OPENCODE_GO_CODING_CHEAP');
  } else if (input.phase === 'pr-review' && risk === 'low' && taskClass === 'docs') {
    role = 'default';
  }

  return choice(role, reasons);
}

/** Next stronger Go model. DeepSeek climbs to Qwen. Kimi has nowhere to go. */
export function nextOpenCodeGoModel(
  current: string | null | undefined,
  tried: readonly string[] = [],
): string | null {
  const seen = new Set(tried);
  if (current !== null && current !== undefined) seen.add(current);
  const start =
    current === OPENCODE_GO_MODELS.codingCheap
      ? OPENCODE_GO_MODELS.default
      : current === null || current === undefined
        ? OPENCODE_GO_MODELS.default
        : (() => {
            const index = OPENCODE_GO_LADDER.indexOf(current);
            return index === -1 ? OPENCODE_GO_MODELS.default : OPENCODE_GO_LADDER[index + 1];
          })();
  if (start === undefined) return null;
  if (!seen.has(start)) return start;
  const startIndex = OPENCODE_GO_LADDER.indexOf(start);
  for (const model of OPENCODE_GO_LADDER.slice(Math.max(0, startIndex))) {
    if (!seen.has(model)) return model;
  }
  return null;
}

export function openCodeGoEntry(model: string): ModelEntry | null {
  const role = ROLE_BY_MODEL[model];
  if (role === undefined) return null;
  const cost = COST_BY_ROLE[role];
  return { id: model, tier: TIER_BY_ROLE[role], ...cost };
}
