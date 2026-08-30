import type { RiskLevel, TaskClass, TaskSignals } from './types.js';

const RISK_PATHS = [/auth/i, /migrat/i, /infra/i, /\.github\//i, /permission/i, /secret/i];

export interface AnalyzedTask {
  taskClass: TaskClass;
  risk: RiskLevel;
}

/** Deterministic. No model, no I/O. Every class is reachable. */
export function analyzeTask(signals: TaskSignals = {}): AnalyzedTask {
  const hay = [
    signals.title ?? '',
    signals.body ?? '',
    ...(signals.labels ?? []),
    ...(signals.paths ?? []),
  ]
    .join(' ')
    .toLowerCase();

  const taskClass = classify(hay, signals);
  const risk = RISK_PATHS.some((pattern) =>
    (signals.paths ?? []).some((path) => pattern.test(path)),
  )
    ? 'high'
    : /security|auth|migrat/.test(hay)
      ? 'high'
      : /refactor|large|epic/.test(hay)
        ? 'medium'
        : 'low';

  return { taskClass, risk };
}

function classify(hay: string, signals: TaskSignals): TaskClass {
  if (/\bdocs?\b|readme|changelog/.test(hay)) return 'docs';
  if (/\btest|spec|coverage/.test(hay)) return 'test';
  if (/\bcie?|deploy|infra|workflow|docker/.test(hay)) return 'infra';
  if (/\banaly[sz]e|investigat|research/.test(hay)) return 'analysis';
  if (/\bbug|fix|regres+ion|crash/.test(hay)) return 'bugfix';
  if (/\brefactor|cleanup|extract/.test(hay)) return 'refactor';
  if (/\bfeat|feature|add |implement/.test(hay)) return 'feature';
  if ((signals.labels ?? []).some((label) => /bug/i.test(label))) return 'bugfix';
  if ((signals.labels ?? []).some((label) => /enhancement|feature/i.test(label))) return 'feature';
  return 'feature';
}
