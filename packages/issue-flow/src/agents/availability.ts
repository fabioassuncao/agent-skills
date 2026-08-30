import { execa } from 'execa';
import { ensureRunnersRegistered, runnerFor } from './registry.js';
import { resolveAgentFor } from './resolve.js';
import type { AgentPhase, AgentProviderId } from './types.js';

export interface AgentAvailability {
  id: AgentProviderId;
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  detail: string;
}

const probeCache = new Map<AgentProviderId, Promise<AgentAvailability>>();

export async function probeAgent(id: AgentProviderId): Promise<AgentAvailability> {
  const cached = probeCache.get(id);
  if (cached) return cached;
  const pending = probeAgentUncached(id);
  probeCache.set(id, pending);
  return pending;
}

async function probeAgentUncached(id: AgentProviderId): Promise<AgentAvailability> {
  ensureRunnersRegistered();
  const runner = runnerFor(id);
  let version: string | null = null;
  let installed = false;
  try {
    const { command, args } = runner.versionCommand();
    const proc = await execa(command, args, { reject: false, timeout: 10_000 });
    installed = proc.exitCode === 0;
    version = installed ? proc.stdout?.toString().trim() || 'unknown' : null;
  } catch {
    installed = false;
  }

  let authenticated = installed;
  let detail = installed ? (version ?? 'installed') : 'not found';

  if (installed && runner.authCommand && runner.capabilities.authProbe !== 'none') {
    try {
      const { command, args } = runner.authCommand();
      const auth = await execa(command, args, { reject: false, timeout: 10_000 });
      const text = `${auth.stdout?.toString() ?? ''}\n${auth.stderr?.toString() ?? ''}`;
      authenticated =
        runner.capabilities.authProbe === 'text'
          ? !/not logged in|not authenticated|no models available/i.test(text)
          : auth.exitCode === 0;
      detail = authenticated ? `${version} (authenticated)` : `${version} (not authenticated)`;
    } catch {
      authenticated = false;
      detail = `${version} (not authenticated)`;
    }
  }

  return { id, installed, version, authenticated, detail };
}

export function installHint(id: AgentProviderId): string {
  if (id === 'codex') {
    return 'Install Codex CLI: https://developers.openai.com/codex/noninteractive';
  }
  if (id === 'cursor') {
    return 'Install Cursor CLI: curl https://cursor.com/install -fsS | bash';
  }
  if (id === 'antigravity') {
    return 'Install Antigravity CLI: https://antigravity.google/docs/cli/install/';
  }
  return 'Install Claude Code: https://docs.anthropic.com/en/docs/claude-code';
}

/**
 * Fail before a run starts when a configured provider is missing or
 * unauthenticated. Names the phase so the user knows which override to fix.
 */
export async function assertAgentAvailable(
  phase: AgentPhase,
  providerId?: AgentProviderId,
): Promise<void> {
  const provider = providerId ?? (await resolveAgentFor(phase)).provider;
  const probe = await probeAgent(provider);
  if (!probe.installed) {
    throw new AgentUnavailableError(
      `Phase '${phase}' is configured to use '${provider}', but ${provider} is not installed. ${installHint(provider)}`,
      phase,
      provider,
    );
  }
  if (!probe.authenticated) {
    throw new AgentUnavailableError(
      `Phase '${phase}' is configured to use '${provider}', but ${provider} is not authenticated. ${
        provider === 'codex'
          ? 'Run: codex login --with-api-key  (or set CODEX_API_KEY)'
          : provider === 'cursor'
            ? 'Run: cursor-agent login (or cursor-agent status)'
            : provider === 'antigravity'
              ? 'Antigravity has no auth probe. Log in with `agy` interactively; Issue Flow never reads GEMINI_API_KEY.'
              : 'Run: claude auth login'
      }`,
      phase,
      provider,
    );
  }
}

export class AgentUnavailableError extends Error {
  readonly phase: AgentPhase;
  readonly provider: AgentProviderId;

  constructor(message: string, phase: AgentPhase, provider: AgentProviderId) {
    super(message);
    this.name = 'AgentUnavailableError';
    this.phase = phase;
    this.provider = provider;
  }
}
