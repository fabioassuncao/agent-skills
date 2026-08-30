import type { TaskClass } from './types.js';

/** Bump when a cell's provenance changes. */
export const PRIORS_VERSION = '1';

/**
 * Cold-start priors. Provenance: author judgement on 2026-08-30 from the
 * #79 baseline and the #76 capability matrix — not measured affinity.
 */
export const PRIORS: Record<TaskClass, Record<string, number>> = {
  bugfix: { 'claude-code': 0.7, 'codex-cli': 0.95, 'cursor-cli': 0.65 },
  feature: { 'claude-code': 0.85, 'codex-cli': 0.8, 'cursor-cli': 0.7 },
  refactor: { 'claude-code': 0.75, 'codex-cli': 0.9, 'cursor-cli': 0.65 },
  docs: { 'claude-code': 0.8, 'codex-cli': 0.7, 'cursor-cli': 0.75 },
  test: { 'claude-code': 0.7, 'codex-cli': 0.9, 'cursor-cli': 0.65 },
  infra: { 'claude-code': 0.8, 'codex-cli': 0.75, 'cursor-cli': 0.6 },
  analysis: { 'claude-code': 0.95, 'codex-cli': 0.6, 'cursor-cli': 0.7 },
};

export function priorFor(taskClass: TaskClass, harness: string): number {
  return PRIORS[taskClass][harness] ?? 0.5;
}
