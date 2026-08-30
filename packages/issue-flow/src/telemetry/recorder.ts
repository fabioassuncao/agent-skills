import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { ClaudeUsage } from '../core/metrics.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { classify } from '../resilience/errors.js';
import type { TaskPlan } from '../types.js';
import { resolveCost } from './pricing.js';
import { redactFailureMessage } from './redact.js';
import { getTelemetrySessionId, setTelemetrySessionId } from './session-id.js';
import {
  DEFAULT_TELEMETRY_CONFIG,
  type ExecutionPurpose,
  type ExecutionRecord,
  type ExecutionStatus,
  type ExecutionTrigger,
  type NormalizedUsage,
  type StopReason,
  type TelemetryConfig,
} from './types.js';

export interface TelemetryContext {
  tasksPath: string;
  sessionId?: string | null;
  config?: TelemetryConfig;
}

let context: TelemetryContext | null = null;
let discardedCount = 0;

export function bindTelemetry(next: TelemetryContext | null): void {
  context = next;
}

export function getTelemetryContext(): TelemetryContext | null {
  return context;
}

export function discardedExecutionCount(): number {
  return discardedCount;
}

export function resetTelemetryState(): void {
  context = null;
  discardedCount = 0;
  setTelemetrySessionId(null);
}

async function resolveConfig(ctx: TelemetryContext): Promise<TelemetryConfig> {
  if (ctx.config !== undefined) return ctx.config;
  try {
    const { loadTelemetryConfig } = await import('../config.js');
    ctx.config = await loadTelemetryConfig();
    return ctx.config;
  } catch {
    return DEFAULT_TELEMETRY_CONFIG;
  }
}

function cap(records: ExecutionRecord[], max: number): ExecutionRecord[] {
  if (records.length <= max) return records;
  discardedCount += records.length - max;
  return records.slice(records.length - max);
}

async function mutate(tasksPath: string, update: (plan: TaskPlan) => TaskPlan): Promise<void> {
  const plan = await loadTaskPlan(tasksPath);
  await saveTaskPlan(tasksPath, update(plan));
}

export function usageFromClaude(usage: ClaudeUsage | null | undefined): NormalizedUsage | null {
  if (usage === undefined || usage === null) return null;
  const next: NormalizedUsage = { source: 'provider' };
  if (usage.inputTokens !== undefined) next.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) next.outputTokens = usage.outputTokens;
  if (usage.cacheReadTokens !== undefined) next.cacheReadTokens = usage.cacheReadTokens;
  if (usage.cacheCreationTokens !== undefined) next.cacheCreationTokens = usage.cacheCreationTokens;
  return next;
}

export interface BeginExecutionInput {
  purpose: ExecutionPurpose;
  attempt?: number;
  trigger?: ExecutionTrigger;
  triggerReason?: ExecutionRecord['triggerReason'];
  harness: string;
  provider?: string | null;
  harnessVersion?: string | null;
  modelRequested?: string | null;
  modelResolved?: string | null;
  modelSource?: ExecutionRecord['agent']['model']['source'];
  iteration?: number;
  routingDecision?: ExecutionRecord['routingDecision'];
}

export async function beginExecution(input: BeginExecutionInput): Promise<string | null> {
  const ctx = context;
  if (ctx === null) return null;
  const cfg = await resolveConfig(ctx);
  if (!cfg.enabled) return null;

  const id = randomUUID();
  const record: ExecutionRecord = {
    id,
    sessionId: ctx.sessionId ?? getTelemetrySessionId(),
    purpose: input.purpose,
    attempt: input.attempt ?? 1,
    trigger: input.trigger ?? 'initial',
    triggerReason: input.triggerReason ?? null,
    agent: {
      harness: input.harness,
      provider: input.provider ?? null,
      harnessVersion: input.harnessVersion ?? null,
      model: {
        requested: input.modelRequested ?? null,
        resolved: input.modelResolved ?? null,
        source: input.modelSource ?? (input.modelResolved ? 'provider' : 'unavailable'),
      },
      providerSessionId: null,
    },
    startedAt: isoNow(),
    finishedAt: null,
    durationMs: null,
    usage: null,
    cost: { status: 'unknown', reason: 'not_reported' },
    status: 'running',
    failure: null,
    owner: { pid: process.pid, host: hostname() },
    ...(input.iteration === undefined ? {} : { iteration: input.iteration }),
    ...(input.routingDecision === undefined || input.routingDecision === null
      ? {}
      : { routingDecision: input.routingDecision }),
  };

  try {
    await mutate(ctx.tasksPath, (plan) => ({
      ...plan,
      executions: cap([...(plan.executions ?? []), record], cfg.maxExecutions),
    }));
    return id;
  } catch {
    return null;
  }
}

/** Wall clock vs CLI envelope: startup the harness does not report. */
export function timingFromUsage(
  wallClockMs: number | null,
  usage: ClaudeUsage | null | undefined,
): Pick<
  ExecutionRecord,
  'cliDurationMs' | 'harnessStartupMs' | 'apiDurationMs' | 'ttftMs' | 'numTurns'
> {
  const cli = usage?.cliDurationMs;
  const cliDurationMs = cli === undefined ? null : cli;
  const harnessStartupMs =
    wallClockMs !== null && cli !== undefined ? Math.max(0, wallClockMs - cli) : null;
  return {
    cliDurationMs,
    harnessStartupMs,
    apiDurationMs: usage?.apiDurationMs ?? null,
    ttftMs: usage?.ttftMs ?? null,
    numTurns: usage?.numTurns ?? null,
  };
}

export async function attachVerdict(verdict: ExecutionRecord['verdict']): Promise<void> {
  const ctx = context;
  if (ctx === null || verdict == null) return;
  try {
    await mutate(ctx.tasksPath, (plan) => {
      const records = [...(plan.executions ?? [])];
      if (records.length === 0) return plan;
      const index = records.length - 1;
      const current = records[index];
      if (current === undefined) return plan;
      records[index] = { ...current, verdict };
      return { ...plan, executions: records };
    });
  } catch {
    // Observational: a failed write must never change the invocation outcome.
  }
}

export interface EndExecutionInput {
  id: string;
  status?: ExecutionStatus;
  usage?: ClaudeUsage | null;
  reportedUsd?: number | null;
  error?: string | null;
  exitCode?: number | null;
  storyIds?: string[];
  cancelled?: boolean;
  timedOut?: boolean;
  modelResolved?: string | null;
  modelSource?: ExecutionRecord['agent']['model']['source'];
  harnessVersion?: string | null;
  providerSessionId?: string | null;
  stopReason?: StopReason | null;
}

export async function endExecution(input: EndExecutionInput): Promise<void> {
  const ctx = context;
  if (ctx === null) return;
  const cfg = await resolveConfig(ctx);
  if (!cfg.enabled) return;

  const usage = usageFromClaude(input.usage);
  const timedOut = input.timedOut === true || /\btimed out\b/i.test(input.error ?? '');
  const cancelled = input.cancelled === true;
  let status: ExecutionStatus = input.status ?? 'completed';
  if (input.status === undefined) {
    if (cancelled) status = 'cancelled';
    else if (timedOut) status = 'timeout';
    else if (input.error) status = 'failed';
  }

  const failure =
    status === 'completed'
      ? null
      : {
          kind: classify({
            source: 'agent',
            stdout: input.error ?? '',
            exitCode: input.exitCode,
            timedOut,
          }).kind,
          message: redactFailureMessage(input.error ?? status),
          exitCode: input.exitCode ?? null,
        };

  try {
    await mutate(ctx.tasksPath, (plan) => {
      const records = [...(plan.executions ?? [])];
      const index = records.findIndex((record) => record.id === input.id);
      if (index === -1) return plan;
      const current = records[index];
      if (current === undefined) return plan;
      const started = Date.parse(current.startedAt);
      const finishedAt = isoNow();
      const modelResolved = input.modelResolved ?? current.agent.model.resolved;
      const modelKey = modelResolved ?? current.agent.model.requested;
      records[index] = {
        ...current,
        agent: {
          ...current.agent,
          harnessVersion: input.harnessVersion ?? current.agent.harnessVersion,
          providerSessionId: input.providerSessionId ?? current.agent.providerSessionId,
          model: {
            ...current.agent.model,
            resolved: modelResolved,
            source:
              input.modelSource ??
              (modelResolved
                ? current.agent.model.source === 'unavailable'
                  ? 'provider'
                  : current.agent.model.source
                : current.agent.model.source),
          },
        },
        finishedAt,
        durationMs: Number.isFinite(started) ? Math.max(0, Date.now() - started) : null,
        ...timingFromUsage(
          Number.isFinite(started) ? Math.max(0, Date.now() - started) : null,
          input.usage,
        ),
        usage,
        cost: resolveCost({
          reportedUsd: input.reportedUsd ?? input.usage?.costUsd,
          usage,
          modelKey,
          estimate: cfg.pricing.estimate,
          overrides: cfg.pricing.overrides,
        }),
        status,
        failure,
        owner: null,
        ...(input.storyIds === undefined ? {} : { storyIds: input.storyIds }),
        ...(input.stopReason === undefined ? {} : { stopReason: input.stopReason }),
      };
      return { ...plan, executions: records };
    });
  } catch {
    // Observational: a failed write must never change the invocation outcome.
  }
}

export async function recordInvocation<T>(
  input: BeginExecutionInput,
  invoke: () => Promise<T>,
  finish: (result: T) => EndExecutionInput,
): Promise<T> {
  const id = await beginExecution(input);
  try {
    const result = await invoke();
    if (id !== null) {
      await endExecution({ ...finish(result), id });
    }
    return result;
  } catch (err) {
    if (id !== null) {
      await endExecution({
        id,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }
}
