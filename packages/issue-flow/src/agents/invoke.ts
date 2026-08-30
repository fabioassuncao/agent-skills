import { getActiveResilienceConfig } from '../config.js';
import { getSessionPublisher } from '../core/session-publisher.js';
import { isoNow } from '../core/state-manager.js';
import { type ClassifiedFailure, classify, type FailureKind } from '../resilience/errors.js';
import type { ProviderHealthRecord } from '../storage/schemas.js';
import { beginExecution, endExecution } from '../telemetry/recorder.js';
import type { ExecutionPurpose, ExecutionTrigger } from '../telemetry/types.js';
import { peekHarnessVersion } from './claude.js';
import { recordProviderFailure, recordProviderSuccess } from './health.js';
import { ensureCursorStorageGrant } from './permissions.js';
import { runnerFor } from './registry.js';
import { type AgentSelection, selectAgentForInvocation } from './select.js';
import type { AgentInvocation, AgentProviderId, AgentRunResult } from './types.js';

const attempts = new Map<string, number>();
const lastFailure = new Map<string, FailureKind>();

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
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

function triggerOf(selection: AgentSelection, attempt: number): ExecutionTrigger {
  if (selection.failover) return 'fallback';
  if (attempt > 1) return 'retry';
  return 'initial';
}

export interface SelectedAgentRun {
  run: AgentRunResult;
  failure: ClassifiedFailure | null;
  selection: AgentSelection;
  attempt: number;
  health: ProviderHealthRecord | null;
}

function nextAttempt(phase: string): number {
  const attempt = (attempts.get(phase) ?? 0) + 1;
  attempts.set(phase, attempt);
  return attempt;
}

export function resetAgentInvocationState(): void {
  attempts.clear();
  lastFailure.clear();
}

/** One invocation, including provider selection, health persistence and audit events. */
export async function invokeSelectedAgent(invocation: AgentInvocation): Promise<SelectedAgentRun> {
  const config = getActiveResilienceConfig();
  const selection = await selectAgentForInvocation(invocation.phase, { config });
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
  }

  const identity = declaredAgentIdentity(selection.provider);
  const requested = selection.settings.model;
  const executionId = await beginExecution({
    purpose: invocation.phase as ExecutionPurpose,
    attempt,
    trigger: triggerOf(selection, attempt),
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
    modelSource: requested ? 'config' : 'unavailable',
  });

  const runner = runnerFor(selection.provider);
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
  try {
    run = await runner.run(
      {
        ...invocation,
        onLine: (line) => {
          publisher.publish({
            type: 'agent:activity',
            at: isoNow(),
            provider: selection.provider,
          });
          invocation.onLine?.(line);
        },
      },
      selection.settings,
    );
  } catch (err) {
    if (executionId !== null) {
      await endExecution({
        id: executionId,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }

  const failure =
    run.success && run.exitCode === 0
      ? null
      : classify({
          source: 'agent',
          exitCode: run.exitCode,
          stdout: run.rawOutput || run.error || '',
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
          ? 'config'
          : 'provider'
        : requested
          ? 'config'
          : 'unavailable',
      harnessVersion: run.harnessVersion ?? peekHarnessVersion(selection.provider) ?? null,
      providerSessionId: run.sessionId ?? null,
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
