import type { TaskPlan } from '../types.js';
import type { ExecutionRecord, ExecutionStatus, ExecutionSummary } from './types.js';

function emptySummary(discarded = 0): ExecutionSummary {
  return {
    count: 0,
    discarded,
    byStatus: {},
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    },
    totalCost: { reported: 0, estimated: 0, unknownExecutions: 0 },
  };
}

function add(into: ExecutionSummary, record: ExecutionRecord): void {
  into.count += 1;
  into.byStatus[record.status] = (into.byStatus[record.status] ?? 0) + 1;
  if (record.usage !== null) {
    into.usage.inputTokens += record.usage.inputTokens ?? 0;
    into.usage.outputTokens += record.usage.outputTokens ?? 0;
    into.usage.cacheReadTokens += record.usage.cacheReadTokens ?? 0;
    into.usage.cacheCreationTokens += record.usage.cacheCreationTokens ?? 0;
    into.usage.reasoningTokens += record.usage.reasoningTokens ?? 0;
  }
  if (record.cost.status === 'reported') {
    into.totalCost.reported += record.cost.amount;
  } else if (record.cost.status === 'estimated') {
    into.totalCost.estimated += record.cost.amount;
  } else {
    into.totalCost.unknownExecutions += 1;
  }
}

function isPlan(value: TaskPlan | readonly ExecutionRecord[]): value is TaskPlan {
  return !Array.isArray(value) && 'userStories' in value;
}

export function summarize(
  input: TaskPlan | readonly ExecutionRecord[],
  discarded = 0,
): ExecutionSummary {
  const records = isPlan(input) ? (input.executions ?? []) : input;
  const summary = emptySummary(discarded);
  for (const record of records) add(summary, record);
  return summary;
}

export type GroupKey = 'harness' | 'provider' | 'model' | 'purpose' | 'status';

function keyOf(record: ExecutionRecord, key: GroupKey): string {
  switch (key) {
    case 'harness':
      return record.agent.harness;
    case 'provider':
      return record.agent.provider ?? 'unknown';
    case 'model':
      return record.agent.model.resolved ?? record.agent.model.requested ?? 'unknown';
    case 'purpose':
      return record.purpose;
    case 'status':
      return record.status;
    default: {
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}

export function groupBy(
  records: readonly ExecutionRecord[],
  key: GroupKey,
): Map<string, ExecutionSummary> {
  const groups = new Map<string, ExecutionRecord[]>();
  for (const record of records) {
    const name = keyOf(record, key);
    const bucket = groups.get(name);
    if (bucket === undefined) groups.set(name, [record]);
    else bucket.push(record);
  }
  const result = new Map<string, ExecutionSummary>();
  for (const [name, bucket] of groups) {
    result.set(name, summarize(bucket));
  }
  return result;
}

export type { ExecutionStatus };
