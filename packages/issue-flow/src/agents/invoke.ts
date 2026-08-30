import { getActiveResilienceConfig } from '../config.js';
import { getSessionPublisher } from '../core/session-publisher.js';
import { isoNow } from '../core/state-manager.js';
import { type ClassifiedFailure, classify } from '../resilience/errors.js';
import type { ProviderHealthRecord } from '../storage/schemas.js';
import { recordProviderFailure, recordProviderSuccess } from './health.js';
import { runnerFor } from './registry.js';
import { type AgentSelection, selectAgentForInvocation } from './select.js';
import type { AgentInvocation, AgentRunResult } from './types.js';

const attempts = new Map<string, number>();

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

  const run = await runnerFor(selection.provider).run(invocation, selection.settings);
  const failure =
    run.success && run.exitCode === 0
      ? null
      : classify({
          source: 'agent',
          exitCode: run.exitCode,
          stdout: run.rawOutput || run.error || '',
        });

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
