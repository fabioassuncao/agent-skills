import { hostname } from 'node:os';
import { isProcessAlive } from '../storage/lock.js';
import type { TaskPlan } from '../types.js';

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Convert orphan `running` records to `interrupted` using the two-signal
 * rule from `storage/lock.ts`: a pid on this host that is gone.
 *
 * A record owned by another host is left `running` — we cannot see that pid.
 */
export function reconcileInterruptedExecutions(plan: TaskPlan): TaskPlan {
  if (plan.executions === undefined || plan.executions.length === 0) return plan;
  let changed = false;
  const executions = plan.executions.map((record) => {
    if (record.status !== 'running' || record.finishedAt !== null) return record;
    const owner = record.owner;
    if (owner === undefined || owner === null) {
      changed = true;
      return { ...record, status: 'interrupted' as const, finishedAt: nowIso(), owner: null };
    }
    if (owner.host !== hostname()) return record;
    if (isProcessAlive(owner.pid)) return record;
    changed = true;
    return { ...record, status: 'interrupted' as const, finishedAt: nowIso(), owner: null };
  });
  return changed ? { ...plan, executions } : plan;
}
