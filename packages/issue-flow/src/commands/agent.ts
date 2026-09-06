import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { probeReadinessInventory } from '../agents/availability.js';
import { describeRunAgents } from '../agents/resolve.js';
import {
  AGENT_PHASES,
  AGENT_SCHEMA_VERSION,
  type AgentPhase,
  type AgentProviderId,
  isAgentPhase,
  isAgentProviderId,
} from '../agents/types.js';
import { GLOBAL_CONFIG_FILENAME, loadAgentConfig, PROJECT_CONFIG_FILENAME } from '../config.js';
import { getGlobalRoot } from '../storage/paths.js';
import { printError, printSuccess } from '../ui/logger.js';
import { writeFileAtomic } from '../utils/fs.js';
import { getProjectRoot } from '../utils/git.js';

export const AGENT_COMMAND_SCHEMA_VERSION = AGENT_SCHEMA_VERSION;

export interface AgentCommandOptions {
  json?: boolean;
}

export interface AgentUseOptions {
  model?: string;
  global?: boolean;
  project?: boolean;
  phase?: string;
}

function originLabel(origin: string): string {
  switch (origin) {
    case 'default':
      return 'default';
    case 'global':
      return '~/.issue-flow/config.json';
    case 'project':
      return '.issue-flow.json';
    case 'env':
      return 'ISSUE_FLOW_*';
    case 'cli':
      return 'CLI';
    default:
      return origin;
  }
}

function formatPhaseLine(
  phase: AgentPhase,
  provider: string,
  model: string | null,
  origin: string,
  inherited: boolean,
): string {
  const modelBit = model ? ` · ${model}` : '';
  const source = inherited ? 'herdado do padrão' : originLabel(origin);
  return `${`  ${phase.padEnd(12)} ${provider}${modelBit}`.padEnd(40)}(${source})`;
}

export async function runAgent(options: AgentCommandOptions = {}): Promise<number> {
  const config = await loadAgentConfig();
  const summary = await describeRunAgents();
  const inventory = await probeReadinessInventory();
  const providers = Object.values(inventory.providers);

  if (options.json === true) {
    const phases: Record<string, unknown> = {};
    for (const phase of AGENT_PHASES) {
      const resolved = summary.byPhase[phase];
      const inherited = config.phases[phase] === undefined;
      phases[phase] = {
        provider: resolved.provider,
        model: resolved.model,
        origin: resolved.origin,
        inherited,
      };
    }
    console.log(
      JSON.stringify(
        {
          schemaVersion: AGENT_COMMAND_SCHEMA_VERSION,
          default: {
            provider: summary.defaultProvider,
            model: summary.defaultModel,
            origin: summary.defaultOrigin,
          },
          phases,
          inventory,
          availability: providers.map((entry) => ({
            id: entry.provider,
            harness: entry.harness,
            installed: entry.installed,
            version: entry.version,
            authenticated: entry.authentication !== 'failed' && entry.installed,
            authentication: entry.authentication,
            state: entry.state,
            source: entry.source,
            observedAt: entry.observedAt,
            expiresAt: entry.expiresAt,
            detail: entry.detail,
            ...(entry.provider === 'antigravity' || entry.provider === 'claude'
              ? { authProbe: 'none' as const }
              : {}),
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const modelLabel = summary.defaultModel ?? '(default do provider)';
  console.log(
    `Agente padrão   ${summary.defaultProvider.padEnd(22)} (${originLabel(summary.defaultOrigin.provider)})`,
  );
  console.log(`Modelo          ${modelLabel} (${originLabel(summary.defaultOrigin.model)})`);
  console.log('');
  console.log('Por fase');
  for (const phase of AGENT_PHASES) {
    const resolved = summary.byPhase[phase];
    const inherited = config.phases[phase] === undefined;
    console.log(
      formatPhaseLine(
        phase,
        resolved.provider,
        resolved.model,
        resolved.origin.provider,
        inherited,
      ),
    );
  }
  console.log('');
  console.log('Disponibilidade');
  for (const entry of providers) {
    const authNote = entry.authentication === 'unverified' ? ' (auth unverified)' : '';
    console.log(
      `  ${entry.provider.padEnd(12)} ${(entry.version ?? '—').padEnd(16)} ${entry.state.padEnd(12)} ${entry.detail}${authNote}`,
    );
  }
  if (inventory.providers.antigravity?.installed) {
    console.log(
      '  Warning: every Antigravity invocation passes --dangerously-skip-permissions. --mode plan is the write containment.',
    );
  }
  return 0;
}

export async function runAgentUse(
  providerRaw: string,
  options: AgentUseOptions = {},
): Promise<number> {
  if (!isAgentProviderId(providerRaw)) {
    printError(
      `Unknown agent provider '${providerRaw}'. Valid providers: claude, codex, cursor, antigravity, opencode.`,
    );
    return 1;
  }
  const provider = providerRaw as AgentProviderId;

  let phase: AgentPhase | undefined;
  if (options.phase !== undefined) {
    if (!isAgentPhase(options.phase)) {
      printError(
        `Unknown agent phase '${options.phase}'. Valid phases: ${AGENT_PHASES.join(', ')}.`,
      );
      return 1;
    }
    phase = options.phase;
  }

  const target: 'global' | 'project' = options.project === true ? 'project' : 'global';
  try {
    const path = await writeAgentPreference({
      target,
      provider,
      model: options.model,
      phase,
    });
    printSuccess(`Wrote agent preference to ${path}`);
    return 0;
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export async function writeAgentPreference(input: {
  target: 'global' | 'project';
  provider: AgentProviderId;
  model?: string;
  phase?: AgentPhase;
  projectRoot?: string;
}): Promise<string> {
  const path =
    input.target === 'global'
      ? join(getGlobalRoot(), GLOBAL_CONFIG_FILENAME)
      : join(input.projectRoot ?? (await getProjectRoot()), PROJECT_CONFIG_FILENAME);

  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Could not read ${path}: ${(err as Error).message}`);
    }
  }

  const currentAgent =
    existing.agent !== null && typeof existing.agent === 'object' && !Array.isArray(existing.agent)
      ? { ...(existing.agent as Record<string, unknown>) }
      : {};

  if (input.phase) {
    const phases =
      currentAgent.phases !== null &&
      typeof currentAgent.phases === 'object' &&
      !Array.isArray(currentAgent.phases)
        ? { ...(currentAgent.phases as Record<string, unknown>) }
        : {};
    phases[input.phase] = {
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
    };
    currentAgent.phases = phases;
  } else {
    currentAgent.provider = input.provider;
    if (input.model) currentAgent.model = input.model;
    else delete currentAgent.model;
  }

  existing.agent = currentAgent;
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(existing, null, 2)}\n`);
  if (input.provider === 'cursor') {
    const { ensureCursorStorageGrant } = await import('../agents/permissions.js');
    await ensureCursorStorageGrant({
      mode: input.target === 'project' ? 'project' : 'global',
      ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
    });
  }
  return path;
}

/** Used by init to persist a first-run choice without touching other keys. */
export async function persistFirstAgentChoice(provider: AgentProviderId): Promise<string> {
  return writeAgentPreference({ target: 'global', provider });
}
