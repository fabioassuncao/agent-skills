import {
  getActiveResilienceConfig,
  getAgentCliOverrides,
  loadAgentConfig,
  loadRoutingConfig,
} from '../config.js';
import { getSessionPublisher } from '../core/session-publisher.js';
import { isoNow } from '../core/state-manager.js';
import { type ClassifiedFailure, classify, type FailureKind } from '../resilience/errors.js';
import { analyzeTask } from '../routing/analyze.js';
import { evaluateCeilings } from '../routing/budget.js';
import { decideRouting } from '../routing/decide.js';
import { bindDiagnosticContext, writeDiagnostic } from '../storage/diagnostics.js';
import type { ProviderHealthRecord } from '../storage/schemas.js';
import { beginExecution, endExecution } from '../telemetry/recorder.js';
import { redactSecrets } from '../telemetry/redact.js';
import type { ExecutionPurpose, ExecutionRecord, ExecutionTrigger } from '../telemetry/types.js';
import { printInfo } from '../ui/logger.js';
import { resolveAntigravityTimeoutMs } from './antigravity.js';
import { probeReadinessInventory } from './availability.js';
import { peekHarnessVersion } from './claude.js';
import { recordProviderFailure, recordProviderSuccess } from './health.js';
import { ensureCursorStorageGrant } from './permissions.js';
import { runnerFor } from './registry.js';
import { applyOpenCodeGoModel, hasExplicitAgentSelection, resolveAgentFor } from './resolve.js';
import { applyRoutingDecision, routingRecommendationLine } from './routing-application.js';
import { type AgentSelection, selectAgentForInvocation } from './select.js';
import type { AgentInvocation, AgentProviderId, AgentRunResult } from './types.js';

async function selectionForForced(invocation: AgentInvocation): Promise<AgentSelection> {
  const settings = await resolveAgentFor(invocation.phase, {
    cli: { forceProvider: invocation.forceProvider },
  });
  return {
    primary: settings.provider,
    provider: settings.provider,
    settings,
    healthFile: null,
    failover: false,
    reason: null,
    cooldownUntil: null,
  };
}

const attempts = new Map<string, number>();
const lastFailure = new Map<string, FailureKind>();
const issueSpend = {
  reportedUsd: 0,
  durationMs: 0,
  executions: 0,
  sawReported: false,
};

/** Declared identity of a runner — never inferred from argv or logs. */
export function declaredAgentIdentity(provider: AgentProviderId): {
  harness: string;
  vendor: string;
} {
  switch (provider) {
    case 'claude':
      return { harness: 'claude-code', vendor: 'anthropic' };
    case 'codex':
      return { harness: 'codex-cli', vendor: 'openai' };
    case 'cursor':
      return { harness: 'cursor-cli', vendor: 'cursor' };
    case 'antigravity':
      return { harness: 'antigravity-cli', vendor: 'google' };
    case 'opencode':
      return { harness: 'opencode-cli', vendor: 'opencode' };
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

function triggerOf(
  selection: AgentSelection,
  attempt: number,
  correctionCycle = 0,
): ExecutionTrigger {
  if (selection.failover) return 'fallback';
  if (attempt > 1) return 'retry';
  if (correctionCycle > 0) return 'correction';
  return 'initial';
}

export interface SelectedAgentRun {
  run: AgentRunResult;
  failure: ClassifiedFailure | null;
  selection: AgentSelection;
  attempt: number;
  health: ProviderHealthRecord | null;
  blocked?: { stopReason: string; detail: string; actor: 'human' };
}

function nextAttempt(phase: string): number {
  const attempt = (attempts.get(phase) ?? 0) + 1;
  attempts.set(phase, attempt);
  return attempt;
}

export function resetAgentInvocationState(): void {
  attempts.clear();
  lastFailure.clear();
  issueSpend.reportedUsd = 0;
  issueSpend.durationMs = 0;
  issueSpend.executions = 0;
  issueSpend.sawReported = false;
}

/** One invocation, including provider selection, health persistence and audit events. */
export async function invokeSelectedAgent(invocation: AgentInvocation): Promise<SelectedAgentRun> {
  const config = getActiveResilienceConfig();
  let selection =
    invocation.forceProvider === undefined
      ? await selectAgentForInvocation(invocation.phase, { config })
      : await selectionForForced(invocation);
  const originalIdentity = declaredAgentIdentity(selection.provider);
  const routingCfg = await loadRoutingConfig();
  const agentCfg = await loadAgentConfig();
  let readiness = null;
  if (routingCfg.mode === 'recommend' || routingCfg.mode === 'active') {
    try {
      readiness = await probeReadinessInventory({
        cooldowns: selection.cooldownUntil
          ? { [selection.provider]: selection.cooldownUntil }
          : undefined,
      });
    } catch {
      // Inventory is best-effort. A probe failure must not block the run —
      // decideRouting falls back to catalog-only scoring.
      readiness = null;
    }
  }
  const issue = getSessionPublisher().snapshot().issue;
  const routingSignals = {
    title: issue.title ?? undefined,
    body: issue.description ?? undefined,
    labels: issue.labels,
  };
  const routingDecision = decideRouting({
    phase: invocation.phase,
    actualHarness: originalIdentity.harness,
    actualProvider: selection.provider,
    actualModel: selection.settings.model,
    mode: routingCfg.mode,
    profile: routingCfg.profile,
    policy: routingCfg.policy,
    skipScore: hasExplicitAgentSelection(agentCfg, getAgentCliOverrides(), invocation.phase),
    requiresExtraDirectories: (invocation.addDirs?.length ?? 0) > 0,
    readiness,
    signals: routingSignals,
    correctionCycle: invocation.correctionCycle,
  });
  const recommendation = routingRecommendationLine(routingDecision, invocation.phase);
  if (recommendation !== null) printInfo(recommendation);
  const routed = await applyRoutingDecision(selection, routingDecision, invocation.phase);
  selection = routed.selection;
  const analyzed = analyzeTask(routingSignals);
  const goSettings = applyOpenCodeGoModel(selection.settings, {
    phase: invocation.phase,
    taskClass: analyzed.taskClass,
    risk: analyzed.risk,
    profile: routingCfg.profile,
    correctionCycle: invocation.correctionCycle,
  });
  if (goSettings !== selection.settings) {
    selection = { ...selection, settings: goSettings };
  }
  if (routed.warning !== null) {
    writeDiagnostic({
      level: 'warning',
      message: routed.warning,
      context: { fallbackFrom: routed.fallbackFrom },
      fields: {
        phase: invocation.phase,
        harness: originalIdentity.harness,
        model: selection.settings.model,
      },
    });
  }
  const attempt = nextAttempt(invocation.phase);
  const publisher = getSessionPublisher();
  publisher.publish({
    type: 'agent:attempt',
    at: isoNow(),
    attempt,
    provider: selection.provider,
    model: selection.settings.model,
    primaryProvider: selection.primary,
  });
  if (selection.failover) {
    publisher.publish({
      type: 'failover',
      at: isoNow(),
      from: selection.primary,
      to: selection.provider,
      reason: selection.reason,
      cooldownUntil: selection.cooldownUntil,
    });
    writeDiagnostic({
      level: 'warning',
      message: `Agent failover from ${selection.primary} to ${selection.provider}`,
      context: { reason: selection.reason, cooldownUntil: selection.cooldownUntil },
      fields: {
        phase: invocation.phase,
        harness: selection.provider,
        model: selection.settings.model,
      },
    });
  }

  const identity = declaredAgentIdentity(selection.provider);
  const requested = selection.settings.model;
  const recordedRoutingDecision =
    routingDecision !== null && routed.applied
      ? {
          ...routingDecision,
          actual: {
            harness: identity.harness,
            provider: selection.provider,
            model: requested,
          },
        }
      : routingDecision;
  const executionId = await beginExecution({
    purpose: (invocation.purpose ?? invocation.phase) as ExecutionPurpose,
    attempt,
    trigger: triggerOf(selection, attempt, invocation.correctionCycle),
    triggerReason: selection.failover
      ? selection.reason
      : attempt > 1
        ? (lastFailure.get(invocation.phase) ?? null)
        : null,
    harness: identity.harness,
    provider: identity.vendor,
    harnessVersion: peekHarnessVersion(selection.provider) ?? null,
    modelRequested: requested,
    modelResolved: null,
    modelSource: requested ? (routed.applied ? 'routing' : 'config') : 'unavailable',
    ...(invocation.iteration === undefined ? {} : { iteration: invocation.iteration }),
    ...(invocation.correctionCycle === undefined
      ? {}
      : { correctionCycle: invocation.correctionCycle }),
    ...(invocation.storyIds === undefined ? {} : { storyIds: invocation.storyIds }),
    ...(recordedRoutingDecision === null
      ? {}
      : {
          routingDecision: recordedRoutingDecision as unknown as ExecutionRecord['routingDecision'],
        }),
  });
  bindDiagnosticContext({
    executionId,
    phase: invocation.phase,
    harness: identity.harness,
    model: requested,
    story: invocation.storyIds?.join(',') ?? null,
  });

  const runner = runnerFor(selection.provider);
  const ceiling = evaluateCeilings({
    ceilings: routingCfg.ceilings,
    spent: {
      reportedUsd: issueSpend.reportedUsd,
      costStatus: issueSpend.sawReported ? 'reported' : 'unknown',
      durationMs: issueSpend.durationMs,
      executions: issueSpend.executions,
    },
  });
  if (!ceiling.ok) {
    const detail = `blocked by ${ceiling.binding} ceiling (${ceiling.numbers.spent} ≥ ${ceiling.numbers.ceiling}). Enforced by Issue Flow, not by a harness flag.`;
    const run = {
      success: false,
      result: '',
      rawOutput: detail,
      exitCode: 1,
      usage: null,
      error: detail,
      agent: { provider: selection.provider, model: selection.settings.model },
      harnessVersion: peekHarnessVersion(selection.provider),
    };
    if (executionId !== null) {
      await endExecution({
        id: executionId,
        status: 'failed',
        error: detail,
        exitCode: 1,
        stopReason: ceiling.stopReason,
      });
    }
    return {
      run,
      failure: null,
      selection,
      attempt,
      health: null,
      blocked: { stopReason: ceiling.stopReason, detail, actor: 'human' },
    };
  }
  if (
    runner.capabilities.nativeTimeout &&
    invocation.timeout === 0 &&
    resolveAntigravityTimeoutMs(invocation, selection.settings) === null
  ) {
    const run = {
      success: false,
      result: '',
      rawOutput:
        'configuration: provider has nativeTimeout and received timeout: 0 without a ceiling.',
      exitCode: 1,
      usage: null,
      error:
        'configuration: provider has nativeTimeout and received timeout: 0 without a ceiling. Set agent.antigravity.executeTimeout.',
      agent: { provider: selection.provider, model: selection.settings.model },
      harnessVersion: peekHarnessVersion(selection.provider),
    };
    if (executionId !== null) {
      await endExecution({
        id: executionId,
        status: 'failed',
        error: run.error,
        exitCode: 1,
      });
    }
    const failure = classify({ source: 'agent', exitCode: 1, stdout: run.error });
    return { run, failure, selection, attempt, health: null };
  }
  if (
    (invocation.addDirs?.length ?? 0) > 0 &&
    runner.capabilities.extraDirectories === 'permission-file'
  ) {
    const grant =
      selection.settings.cursor.permissionsFile === 'none'
        ? { skipped: true as const, reason: 'none' as const }
        : await ensureCursorStorageGrant({
            mode: selection.settings.cursor.permissionsFile ?? 'global',
          });
    if ('skipped' in grant && selection.settings.cursor.permissionsFile !== 'none') {
      throw new Error(
        `Phase '${invocation.phase}' needs extraDirectories on '${selection.provider}', which only grants them via a permission file. Run \`issue-flow agent use cursor\` or set agent.cursor.permissionsFile.`,
      );
    }
  } else if (
    (invocation.addDirs?.length ?? 0) > 0 &&
    runner.capabilities.extraDirectories === 'none'
  ) {
    throw new Error(
      `Phase '${invocation.phase}' needs extraDirectories, but '${selection.provider}' cannot grant them.`,
    );
  }

  let run: AgentRunResult;
  const startedMs = Date.now();
  try {
    run = await runner.run(
      {
        ...invocation,
        onLine: (line) => {
          const sanitized = redactSecrets(line).slice(0, 4_000);
          publisher.publish({
            type: 'agent:activity',
            at: isoNow(),
            provider: selection.provider,
          });
          if (sanitized.trim() !== '') {
            publisher.publish({
              type: 'process:output',
              at: isoNow(),
              phase: invocation.phase,
              executionId,
              provider: selection.provider,
              stream: 'combined',
              message: sanitized,
            });
            writeDiagnostic({
              level: 'debug',
              message: sanitized,
              fields: {
                executionId,
                phase: invocation.phase,
                harness: identity.harness,
                model: selection.settings.model,
              },
            });
          }
          invocation.onLine?.(line);
        },
      },
      selection.settings,
    );
  } catch (err) {
    writeDiagnostic({
      level: 'error',
      message: `Agent invocation threw before producing a result: ${
        err instanceof Error ? err.message : String(err)
      }`,
      exception: err,
      fields: {
        executionId,
        phase: invocation.phase,
        harness: identity.harness,
        model: selection.settings.model,
      },
    });
    if (executionId !== null) {
      await endExecution({
        id: executionId,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }
  issueSpend.executions += 1;
  issueSpend.durationMs += Math.max(0, Date.now() - startedMs);
  if (run.usage?.costUsd !== undefined) {
    issueSpend.reportedUsd += run.usage.costUsd;
    issueSpend.sawReported = true;
  }

  const failure =
    run.success && run.exitCode === 0
      ? null
      : classify({
          source: 'agent',
          exitCode: run.exitCode,
          stdout: run.rawOutput || run.error || '',
        });
  writeDiagnostic({
    level: failure === null ? 'info' : 'error',
    message:
      failure === null
        ? `Agent invocation completed with ${selection.provider}`
        : `Agent invocation failed with ${selection.provider}: ${failure.message}`,
    context: {
      attempt,
      exitCode: run.exitCode,
      failureKind: failure?.kind ?? null,
      trigger: triggerOf(selection, attempt, invocation.correctionCycle),
    },
    fields: {
      executionId,
      phase: invocation.phase,
      harness: identity.harness,
      model: run.agent.model,
    },
  });

  if (executionId !== null) {
    await endExecution({
      id: executionId,
      status: failure === null ? 'completed' : failure.kind === 'timeout' ? 'timeout' : 'failed',
      usage: run.usage,
      error: failure === null ? null : (run.error ?? run.rawOutput),
      exitCode: run.exitCode,
      modelResolved: run.agent.model,
      modelSource: run.agent.model
        ? requested
          ? routed.applied
            ? 'routing'
            : 'config'
          : 'provider'
        : requested
          ? routed.applied
            ? 'routing'
            : 'config'
          : 'unavailable',
      harnessVersion: run.harnessVersion ?? peekHarnessVersion(selection.provider) ?? null,
      providerSessionId: run.sessionId ?? null,
      storyIds: invocation.storyIds,
    });
  }

  if (failure === null) lastFailure.delete(invocation.phase);
  else lastFailure.set(invocation.phase, failure.kind);

  let health: ProviderHealthRecord | null = null;
  if (selection.healthFile !== null) {
    health =
      failure === null
        ? await recordProviderSuccess(selection.healthFile, selection.provider)
        : await recordProviderFailure(selection.healthFile, selection.provider, failure, {
            config: config.providers,
          });
  }

  publisher.publish({
    type: 'agent:result',
    at: isoNow(),
    provider: selection.provider,
    success: failure === null,
    ...(failure === null ? {} : { failureKind: failure.kind }),
    cooldownUntil: health?.cooldownUntil ?? null,
  });

  if (failure === null) attempts.delete(invocation.phase);
  return { run, failure, selection, attempt, health };
}
