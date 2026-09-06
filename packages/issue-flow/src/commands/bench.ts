import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { BENCH_MODES, type BenchMode, TASK_CLASSES, type TaskClass } from '../benchmark/corpus.js';
import { createLiveRepeatRunner } from '../benchmark/live.js';
import { type BenchCampaign, type RepeatRunner, runRealCorpus } from '../benchmark/real.js';
import { renderCampaignMarkdown } from '../benchmark/report.js';
import { runSyntheticCorpus } from '../benchmark/synthetic.js';
import { collectHarnessVersion } from '../benchmark/tuple.js';
import { printError, printInfo, printWarning } from '../ui/logger.js';
import { isInteractive, promptConfirm } from '../ui/prompts.js';

/** p50 USD from the #79 before table — used only for the pre-flight estimate. */
export const BASELINE_COST_P50_USD: Record<TaskClass, number> = {
  trivial: 0.2,
  small: 3.17,
  medium: 6.08,
  analysis: 1.86,
};

export class BenchConfirmationError extends Error {
  readonly exitCode = 1;
  constructor(message: string) {
    super(message);
    this.name = 'BenchConfirmationError';
  }
}

export interface BenchOptions {
  mode?: BenchMode;
  task?: string[];
  arm?: string[];
  repeats?: number;
  maxCost?: number;
  maxDuration?: number;
  out?: string;
  yes?: boolean;
  repo?: string;
  json?: boolean;
  interactive?: boolean;
  stdin?: Readable;
  stdout?: Writable;
  signal?: AbortSignal;
  runPipeline?: (issue: string) => Promise<number>;
  runner?: RepeatRunner;
  harnessVersion?: string;
}

export function estimateCampaignUsd(tasks: TaskClass[], arms: number, repeats: number): number {
  const perRepeat = tasks.reduce((sum, task) => sum + BASELINE_COST_P50_USD[task], 0);
  return perRepeat * arms * repeats;
}

export async function confirmRealCampaign(
  estimate: { cells: number; repeats: number; usd: number; maxCost?: number; maxDuration?: number },
  options: Pick<BenchOptions, 'yes' | 'interactive' | 'stdin' | 'stdout' | 'signal'> = {},
): Promise<void> {
  printInfo(
    `Real campaign: ${estimate.cells} cells × ${estimate.repeats} repeats ≈ $${estimate.usd.toFixed(2)} (p50 of the #79 baseline).`,
  );
  if (estimate.maxCost !== undefined) {
    printInfo(`Cost ceiling: $${estimate.maxCost.toFixed(2)}.`);
  }
  if (estimate.maxDuration !== undefined) {
    printInfo(`Duration ceiling: ${estimate.maxDuration}ms.`);
  }
  if (options.yes === true) {
    printInfo('--yes: starting the campaign.');
    return;
  }
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const interactive = options.interactive ?? isInteractive({ stdin, stdout, ci: process.env.CI });
  if (!interactive) {
    throw new BenchConfirmationError(
      'A real campaign spends money and the terminal is not interactive. Re-run with --yes.',
    );
  }
  const result = await promptConfirm({
    message: 'Proceed with a paid campaign?',
    initialValue: false,
    stdin,
    stdout,
    signal: options.signal,
  });
  if (result.status === 'cancelled' || result.value !== true) {
    throw new BenchConfirmationError('Cancelled: the campaign was not confirmed.');
  }
}

function parseTasks(values: string[] | undefined): TaskClass[] {
  if (values === undefined || values.length === 0) return [...TASK_CLASSES];
  const tasks: TaskClass[] = [];
  for (const value of values) {
    if (!(TASK_CLASSES as readonly string[]).includes(value)) {
      throw new BenchConfirmationError(
        `Unknown task class '${value}'. Must be one of: ${TASK_CLASSES.join(', ')}.`,
      );
    }
    if (!tasks.includes(value as TaskClass)) tasks.push(value as TaskClass);
  }
  return tasks;
}

function printSynthetic(): void {
  const rows = runSyntheticCorpus();
  printInfo('Synthetic corpus (orchestration only; harness is a number).');
  for (const row of rows) {
    printInfo(
      `${row.task}  duration=${row.taskDurationMs.toFixed(1)}ms  overhead=${row.orchestrationOverheadMs.toFixed(1)}ms  verdict=${row.verdict}`,
    );
  }
}

export async function runBench(options: BenchOptions = {}): Promise<number> {
  const mode = options.mode ?? 'synthetic';
  if (!(BENCH_MODES as readonly string[]).includes(mode)) {
    printError(`Unknown bench mode '${mode}'. Use one of: ${BENCH_MODES.join(', ')}.`);
    return 1;
  }
  if (mode === 'synthetic') {
    printSynthetic();
    return 0;
  }
  if (options.repo !== undefined) {
    printWarning(
      '--repo is an investigation escape: the row is not publishable. A disposable fixture is the only source of a comparable line.',
    );
  }

  let tasks: TaskClass[];
  try {
    tasks = parseTasks(options.task);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const arms = options.arm !== undefined && options.arm.length > 0 ? options.arm : ['baseline'];
  const repeats = options.repeats ?? 5;
  const usd = estimateCampaignUsd(tasks, arms.length, repeats);

  try {
    await confirmRealCampaign(
      {
        cells: tasks.length * arms.length,
        repeats,
        usd,
        ...(options.maxCost === undefined ? {} : { maxCost: options.maxCost }),
        ...(options.maxDuration === undefined ? {} : { maxDuration: options.maxDuration }),
      },
      options,
    );
  } catch (error) {
    if (error instanceof BenchConfirmationError) {
      printError(error.message);
      return error.exitCode;
    }
    throw error;
  }

  const harnessVersion = options.harnessVersion ?? (await collectHarnessVersion('claude'));
  const runner =
    options.runner ??
    createLiveRepeatRunner({
      runPipeline:
        options.runPipeline ??
        (async (issue) => {
          const { runPipeline } = await import('./run.js');
          return runPipeline(issue, 'auto', undefined, true, false, { yes: true, only: true });
        }),
    });

  const campaign: BenchCampaign = await runRealCorpus({
    tasks,
    arms,
    repeats,
    tupleBase: {
      harness: 'claude',
      harnessVersion,
      model: 'default',
      modelVersion: null,
      effort: 'default',
      verification: 'none',
      strategy: 'pipeline',
      settingSourcesPinned: true,
      fallbackModelPassed: false,
    },
    ...(options.maxCost === undefined ? {} : { maxCostUsd: options.maxCost }),
    ...(options.maxDuration === undefined ? {} : { maxDurationMs: options.maxDuration }),
    runner,
  });

  if (campaign.stop.reason !== 'completed') {
    printWarning(
      `Campaign stopped on ${campaign.stop.reason} (spent ${campaign.stop.spent}, ceiling ${campaign.stop.ceiling}). Report is partial.`,
    );
  }

  const markdown = renderCampaignMarkdown(campaign, arms.join('-vs-'));
  if (options.out) {
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, markdown, 'utf-8');
    printInfo(`Wrote ${options.out}`);
  } else {
    (options.stdout ?? process.stdout).write(markdown);
  }
  if (options.json === true) {
    (options.stdout ?? process.stdout).write(`${JSON.stringify(campaign, null, 2)}\n`);
  }
  return campaign.stop.reason === 'completed' ? 0 : 2;
}
