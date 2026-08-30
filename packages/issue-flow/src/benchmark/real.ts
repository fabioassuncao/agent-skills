import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateCeilings, spendFromCost } from '../routing/budget.js';
import { getGlobalRoot } from '../storage/paths.js';
import type { CostRecord, ExecutionRecord } from '../telemetry/types.js';
import type { VerdictStatus } from '../verify/types.js';
import { CORPUS, type TaskClass } from './corpus.js';
import { corpusTask, type FixtureHandle, materialize } from './fixtures/index.js';
import { p50, p95 } from './stats.js';
import {
  assertComparable,
  type ComparabilityTuple,
  isRowInvalid,
  type TupleField,
  tupleAxisForArm,
} from './tuple.js';

export interface BenchRepeat {
  seed: number;
  taskDurationMs: number;
  harnessExecutionMs: number;
  orchestrationOverheadMs: number;
  timeToAcceptedResultMs: number | null;
  verdict: VerdictStatus;
  cost: CostRecord;
  attemptCount: number;
  executionIds: string[];
  invalid: boolean;
}

export interface BenchCell {
  task: TaskClass;
  tuple: ComparabilityTuple;
  arm: string;
  repeats: BenchRepeat[];
}

export interface PercentilePair {
  p50: number;
  p95: number;
  n: number;
}

export interface CellSummary {
  n: number;
  taskDurationMs: PercentilePair;
  harnessExecutionMs: PercentilePair;
  orchestrationOverheadMs: PercentilePair;
  timeToAcceptedResultMs: { p50: number | null; p95: number | null; n: number };
  cost: {
    reportedP50: number | null;
    reportedP95: number | null;
    unknownRepeats: number;
    estimatedRepeats: number;
  };
  verdicts: Record<VerdictStatus, number>;
}

export type CampaignStop =
  | { reason: 'completed' }
  | { reason: 'max_cost' | 'max_duration'; spent: number; ceiling: number; partial: true };

export interface BenchCampaign {
  id: string;
  home: string;
  cells: BenchCell[];
  stop: CampaignStop;
}

export interface RepeatOutcome {
  records: ExecutionRecord[];
  verdict: VerdictStatus;
  taskDurationMs: number;
  harnessExecutionMs: number;
  orchestrationOverheadMs: number;
  attemptCount: number;
  cost: CostRecord;
}

export interface RepeatRunnerInput {
  fixture: FixtureHandle;
  arm: string;
  tuple: ComparabilityTuple;
  campaignHome: string;
}

export type RepeatRunner = (input: RepeatRunnerInput) => Promise<RepeatOutcome>;

export interface RealCorpusOptions {
  tasks?: TaskClass[];
  arms: string[];
  repeats: number;
  tupleBase: Omit<ComparabilityTuple, 'task' | 'strictMcpConfig' | 'fallbackModelPassed'> & {
    strictMcpConfig?: boolean;
    fallbackModelPassed?: boolean;
  };
  maxCostUsd?: number;
  maxDurationMs?: number;
  campaignId?: string;
  runner: RepeatRunner;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export function campaignHome(campaignId: string, env?: NodeJS.ProcessEnv): string {
  return join(getGlobalRoot({ env }), 'bench', campaignId);
}

function combineCost(records: readonly ExecutionRecord[]): CostRecord {
  let reported = 0;
  let estimated = 0;
  let unknown = 0;
  for (const record of records) {
    if (record.cost.status === 'reported') reported += record.cost.amount;
    else if (record.cost.status === 'estimated') estimated += record.cost.amount;
    else unknown += 1;
  }
  if (reported > 0) return { status: 'reported', amount: reported, currency: 'USD' };
  if (estimated > 0) {
    return {
      status: 'estimated',
      amount: estimated,
      currency: 'USD',
      pricing: {
        tableVersion: 'bench',
        modelKey: 'aggregated',
        inputPerMillion: 0,
        outputPerMillion: 0,
        capturedAt: new Date(0).toISOString(),
      },
    };
  }
  return { status: 'unknown', reason: unknown > 0 ? 'not_reported' : 'not_reported' };
}

export function summarizeCell(cell: BenchCell): CellSummary {
  const durations = cell.repeats.map((repeat) => repeat.taskDurationMs);
  const harness = cell.repeats.map((repeat) => repeat.harnessExecutionMs);
  const overhead = cell.repeats.map((repeat) => repeat.orchestrationOverheadMs);
  const accepted = cell.repeats
    .map((repeat) => repeat.timeToAcceptedResultMs)
    .filter((value): value is number => value !== null);
  const reported = cell.repeats
    .map((repeat) => (repeat.cost.status === 'reported' ? repeat.cost.amount : null))
    .filter((value): value is number => value !== null);
  const verdicts: Record<VerdictStatus, number> = { passed: 0, failed: 0, unverified: 0 };
  let unknownRepeats = 0;
  let estimatedRepeats = 0;
  for (const repeat of cell.repeats) {
    verdicts[repeat.verdict] += 1;
    if (repeat.cost.status === 'unknown') unknownRepeats += 1;
    if (repeat.cost.status === 'estimated') estimatedRepeats += 1;
  }
  return {
    n: cell.repeats.length,
    taskDurationMs: { p50: p50(durations), p95: p95(durations), n: durations.length },
    harnessExecutionMs: { p50: p50(harness), p95: p95(harness), n: harness.length },
    orchestrationOverheadMs: { p50: p50(overhead), p95: p95(overhead), n: overhead.length },
    timeToAcceptedResultMs: {
      p50: accepted.length === 0 ? null : p50(accepted),
      p95: accepted.length === 0 ? null : p95(accepted),
      n: accepted.length,
    },
    cost: {
      reportedP50: reported.length === 0 ? null : p50(reported),
      reportedP95: reported.length === 0 ? null : p95(reported),
      unknownRepeats,
      estimatedRepeats,
    },
    verdicts,
  };
}

function tupleForArm(
  task: TaskClass,
  arm: string,
  base: RealCorpusOptions['tupleBase'],
): ComparabilityTuple {
  return {
    task,
    harness: base.harness,
    harnessVersion: base.harnessVersion,
    model: base.model,
    modelVersion: base.modelVersion,
    effort: base.effort,
    verification: base.verification,
    strategy: base.strategy,
    settingSourcesPinned: base.settingSourcesPinned,
    strictMcpConfig: arm === 'strict-mcp' ? true : (base.strictMcpConfig ?? false),
    fallbackModelPassed: base.fallbackModelPassed ?? false,
  };
}

function declaredIgnore(arms: readonly string[]): TupleField[] {
  const fields = new Set<TupleField>();
  for (const arm of arms) {
    const axis = tupleAxisForArm(arm);
    if (axis) fields.add(axis);
  }
  return [...fields];
}

/**
 * Run the real corpus. Arms are a parameter: new experiments do not add
 * runner code. Repeats of different arms are interleaved, not blocked.
 */
export async function runRealCorpus(options: RealCorpusOptions): Promise<BenchCampaign> {
  const tasks = options.tasks ?? CORPUS.map((entry) => entry.id);
  const campaignId = options.campaignId ?? `campaign-${Date.now()}`;
  const home = campaignHome(campaignId, options.env);
  await mkdir(home, { recursive: true });

  const cells = new Map<string, BenchCell>();
  const ignore = declaredIgnore(options.arms);
  const now = options.now ?? Date.now;
  const started = now();
  let reportedUsd = 0;
  let knownCost: CostRecord['status'] = 'unknown';
  let stop: CampaignStop = { reason: 'completed' };

  const schedule: Array<{ task: TaskClass; arm: string; seed: number }> = [];
  for (let seed = 0; seed < options.repeats; seed += 1) {
    for (const arm of options.arms) {
      for (const task of tasks) {
        schedule.push({ task, arm, seed });
      }
    }
  }

  for (const step of schedule) {
    const task = corpusTask(step.task);
    const tuple = tupleForArm(step.task, step.arm, {
      ...options.tupleBase,
      verification: task.verification,
      strategy: task.strategy,
    });
    const key = `${step.task}:${step.arm}`;
    const existing = cells.get(key);
    if (existing) {
      assertComparable(existing.tuple, tuple, { ignore });
    } else {
      for (const cell of cells.values()) {
        if (cell.task !== step.task) continue;
        assertComparable(cell.tuple, tuple, { ignore });
      }
      cells.set(key, { task: step.task, tuple, arm: step.arm, repeats: [] });
    }

    const fixture = await materialize(task, step.seed);
    try {
      const outcome = await options.runner({
        fixture,
        arm: step.arm,
        tuple,
        campaignHome: home,
      });
      const cost = outcome.cost.status !== undefined ? outcome.cost : combineCost(outcome.records);
      const spent = spendFromCost(cost);
      if (spent.costStatus === 'reported') {
        reportedUsd += spent.reportedUsd;
        knownCost = 'reported';
      }
      const cell = cells.get(key);
      if (!cell) throw new Error(`missing cell ${key}`);
      cell.repeats.push({
        seed: step.seed,
        taskDurationMs: outcome.taskDurationMs,
        harnessExecutionMs: outcome.harnessExecutionMs,
        orchestrationOverheadMs: outcome.orchestrationOverheadMs,
        timeToAcceptedResultMs: outcome.verdict === 'passed' ? outcome.taskDurationMs : null,
        verdict: outcome.verdict,
        cost,
        attemptCount: outcome.attemptCount,
        executionIds: outcome.records.map((record) => record.id),
        invalid: isRowInvalid(tuple),
      });
    } finally {
      await fixture.dispose();
    }

    const ceiling = evaluateCeilings({
      ceilings: {
        maxCostUsdPerIssue: options.maxCostUsd ?? null,
        maxDurationMsPerIssue: options.maxDurationMs ?? null,
        maxExecutionsPerIssue: null,
        onCeiling: 'block',
      },
      spent: {
        reportedUsd,
        costStatus: knownCost,
        durationMs: now() - started,
        executions: [...cells.values()].reduce((sum, cell) => sum + cell.repeats.length, 0),
      },
    });
    if (!ceiling.ok) {
      stop = {
        reason: ceiling.stopReason === 'max_attempts' ? 'max_duration' : ceiling.stopReason,
        spent: ceiling.numbers.spent,
        ceiling: ceiling.numbers.ceiling,
        partial: true,
      };
      break;
    }
  }

  return { id: campaignId, home, cells: [...cells.values()], stop };
}
