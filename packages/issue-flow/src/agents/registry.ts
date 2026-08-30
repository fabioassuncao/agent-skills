import { execa } from 'execa';
import { ClaudeCodeRunner, cacheHarnessVersion, peekHarnessVersion } from './claude.js';
import { CodexRunner } from './codex.js';
import type { AgentProviderId, AgentRunner } from './types.js';

const runners = new Map<AgentProviderId, AgentRunner>();

export function registerRunner(runner: AgentRunner): void {
  runners.set(runner.id, runner);
}

export function getRegisteredProviders(): AgentProviderId[] {
  return [...runners.keys()];
}

export function clearRunners(): void {
  runners.clear();
}

export function ensureRunnersRegistered(): void {
  const registered = new Set(getRegisteredProviders());
  if (!registered.has('claude')) registerRunner(new ClaudeCodeRunner());
  if (!registered.has('codex')) registerRunner(new CodexRunner());
}

/**
 * Look up the runner for a provider.
 *
 * @throws when the id is not registered, listing what is available.
 */
export function runnerFor(providerId: AgentProviderId): AgentRunner {
  ensureRunnersRegistered();
  const runner = runners.get(providerId);
  if (runner === undefined) {
    const available = getRegisteredProviders();
    const hint =
      available.length > 0
        ? `Available providers: ${available.join(', ')}.`
        : 'No agent runners are registered.';
    throw new Error(`Unknown agent provider: '${providerId}'. ${hint}`);
  }
  return runner;
}

export async function ensureHarnessVersion(providerId: AgentProviderId): Promise<string | null> {
  const cached = peekHarnessVersion(providerId);
  if (cached !== undefined) return cached;

  const runner = runnerFor(providerId);
  const { command, args } = runner.versionCommand();
  try {
    const proc = await execa(command, args, { reject: false, timeout: 10_000 });
    const version = proc.exitCode === 0 ? (proc.stdout?.toString().trim() ?? null) : null;
    cacheHarnessVersion(providerId, version);
    return version;
  } catch {
    cacheHarnessVersion(providerId, null);
    return null;
  }
}
