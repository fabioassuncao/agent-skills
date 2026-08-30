import { readdir } from 'node:fs/promises';
import { loadTaskPlan } from '../core/state-manager.js';
import { getIssuePaths } from '../storage/paths.js';
import { resolveProjectPaths } from '../storage/resolve.js';
import { type GroupKey, groupBy, summarize } from '../telemetry/aggregate.js';
import { discardedExecutionCount } from '../telemetry/recorder.js';
import type { ExecutionRecord, ExecutionSummary } from '../telemetry/types.js';
import type { TaskPlan } from '../types.js';
import { printError, printInfo } from '../ui/logger.js';

export const USAGE_GROUP_KEYS = [
  'harness',
  'provider',
  'model',
  'purpose',
  'status',
] as const satisfies readonly GroupKey[];

export type UsageGroupKey = (typeof USAGE_GROUP_KEYS)[number];

export interface UsageOptions {
  issue?: string;
  since?: string;
  by?: UsageGroupKey;
  json?: boolean;
}

export interface UsageReport {
  issue: string | null;
  since: string | null;
  by: UsageGroupKey | null;
  discarded: number;
  total: ExecutionSummary;
  groups: Array<{ key: string; summary: ExecutionSummary }>;
}

function sinceCutoff(since: string | undefined): number | null {
  if (since === undefined || since === '') return null;
  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? null : parsed;
}

function afterCutoff(
  records: readonly ExecutionRecord[],
  cutoff: number | null,
): ExecutionRecord[] {
  if (cutoff === null) return [...records];
  return records.filter((record) => Date.parse(record.startedAt) >= cutoff);
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatCost(summary: ExecutionSummary): string {
  const parts: string[] = [];
  if (summary.totalCost.reported > 0 || summary.totalCost.estimated === 0) {
    if (summary.count > 0 && summary.totalCost.unknownExecutions < summary.count) {
      parts.push(`${formatUsd(summary.totalCost.reported)} reportado`);
    }
  }
  if (summary.totalCost.estimated > 0) {
    parts.push(`${formatUsd(summary.totalCost.estimated)} estimado`);
  }
  if (summary.totalCost.unknownExecutions > 0) {
    parts.push(`— desconhecido (${summary.totalCost.unknownExecutions})`);
  }
  return parts.length === 0 ? '—' : parts.join(' · ');
}

function formatTokens(summary: ExecutionSummary): string {
  const total = summary.usage.inputTokens + summary.usage.outputTokens;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`;
  return String(total);
}

function successRate(summary: ExecutionSummary): string {
  if (summary.count === 0) return '—';
  const ok = summary.byStatus.completed ?? 0;
  return `${((ok / summary.count) * 100).toFixed(1)}%`;
}

async function loadPlans(
  issue: string | undefined,
): Promise<{ id: string; plan: TaskPlan }[] | null> {
  let project: Awaited<ReturnType<typeof resolveProjectPaths>>;
  try {
    project = await resolveProjectPaths();
  } catch (err) {
    printError(`Not inside a usable project: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  if (issue !== undefined) {
    try {
      const paths = getIssuePaths(project.projectId, issue);
      return [{ id: issue, plan: await loadTaskPlan(paths.tasksFile) }];
    } catch (err) {
      printError(
        `No telemetry for issue ${issue}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  let ids: string[];
  try {
    ids = await readdir(project.issuesDir);
  } catch {
    return [];
  }

  const loaded: { id: string; plan: TaskPlan }[] = [];
  for (const id of ids) {
    try {
      loaded.push({
        id,
        plan: await loadTaskPlan(getIssuePaths(project.projectId, id).tasksFile),
      });
    } catch {
      // An issue without a readable plan is not telemetry.
    }
  }
  return loaded;
}

export function buildUsageReport(
  plans: { id: string; plan: TaskPlan }[],
  options: UsageOptions,
  discarded = 0,
): UsageReport {
  const cutoff = sinceCutoff(options.since);
  const records = plans.flatMap(({ plan }) => afterCutoff(plan.executions ?? [], cutoff));
  const total = summarize(records, discarded);
  const groups =
    options.by === undefined
      ? []
      : [...groupBy(records, options.by)].map(([key, summary]) => ({ key, summary }));
  return {
    issue: options.issue ?? (plans.length === 1 ? (plans[0]?.id ?? null) : null),
    since: options.since ?? null,
    by: options.by ?? null,
    discarded,
    total,
    groups,
  };
}

export function formatUsageReport(report: UsageReport): string {
  if (report.total.count === 0) {
    return 'No execution telemetry recorded yet.';
  }

  const header = [
    report.issue === null ? 'project' : `issue #${report.issue}`,
    `${report.total.count} execução${report.total.count === 1 ? '' : 'ões'}`,
    formatCost(report.total),
  ].join(' · ');

  if (report.by === null || report.groups.length === 0) {
    return header;
  }

  const rows = report.groups.map((group) => {
    const name = group.key.padEnd(14);
    const count = String(group.summary.count).padStart(10);
    const success = successRate(group.summary).padStart(8);
    const tokens = formatTokens(group.summary).padStart(8);
    return `${name}${count}${success}${tokens.padStart(10)}  ${formatCost(group.summary)}`;
  });
  const columns = `${report.by.padEnd(14)}${'execuções'.padStart(10)}${'sucesso'.padStart(8)}${'tokens'.padStart(10)}  custo`;
  return [`${header}`, columns, ...rows].join('\n');
}

export async function runUsage(
  issue: string | undefined,
  options: UsageOptions = {},
): Promise<number> {
  const plans = await loadPlans(issue ?? options.issue);
  if (plans === null) return 1;

  if (options.since !== undefined && sinceCutoff(options.since) === null) {
    printError(`Invalid --since date: ${options.since}`);
    return 1;
  }

  const report = buildUsageReport(plans, { ...options, issue: issue ?? options.issue });
  if (plans.length === 0 || (report.total.count === 0 && (issue ?? options.issue) !== undefined)) {
    printInfo('No execution telemetry recorded yet.');
    return 0;
  }

  if (options.json === true) {
    printInfo(JSON.stringify(report, null, 2));
    return 0;
  }

  printInfo(formatUsageReport(report));
  return 0;
}

export { discardedExecutionCount };
