import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type CustomAgentDefinition, isCanonicalCustomAgentId } from '../agents/custom.js';
import { withSerializedFileLock } from '../storage/lock.js';
import { printWarning } from '../ui/logger.js';
import { writeFileAtomic } from '../utils/fs.js';
import { loadGlobalConfig, PROJECT_CONFIG_FILENAME, readProjectConfigFile } from './sources.js';

/** User-defined terminal agents, keyed by their stable normalized id. */
export type CustomAgentsConfig = Record<string, CustomAgentDefinition>;

export interface LoadCustomAgentsConfigOptions {
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
  globalRoot?: string;
  warn?: (message: string) => void;
}

type AgentLayer = Record<string, CustomAgentDefinition | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseAgent(raw: unknown, id: string): CustomAgentDefinition | null | undefined {
  if (raw === null) return null;
  if (!isRecord(raw)) return undefined;
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  const startCommand = typeof raw.startCommand === 'string' ? raw.startCommand.trim() : '';
  const resumeCommand = typeof raw.resumeCommand === 'string' ? raw.resumeCommand.trim() : '';
  if (label === '' || startCommand === '') return undefined;
  return {
    id,
    label,
    startCommand,
    ...(resumeCommand === '' ? {} : { resumeCommand }),
  };
}

function parseLayer(raw: unknown, source: string, warn: (message: string) => void): AgentLayer {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    warn(`Ignoring "agents" key of ${source}: expected an object.`);
    return {};
  }
  const parsed = Object.create(null) as AgentLayer;
  for (const [rawId, value] of Object.entries(raw)) {
    const id = rawId.trim();
    const agent = parseAgent(value, id);
    if (!isCanonicalCustomAgentId(id) || agent === undefined) {
      warn(`Ignoring invalid custom agent "${rawId}" from ${source}.`);
      continue;
    }
    parsed[id] = agent;
  }
  return parsed;
}

/**
 * Resolve custom agents through the normal configuration ladder.
 *
 * The project layer overlays the machine layer by id. A `null` project entry
 * is a tombstone, allowing one project to hide an inherited agent without
 * editing the user's machine-wide preferences.
 */
export async function loadCustomAgentsConfig(
  options: LoadCustomAgentsConfigOptions = {},
): Promise<CustomAgentsConfig> {
  const warn = options.warn ?? printWarning;
  const global = await loadGlobalConfig({
    env: options.env,
    globalRoot: options.globalRoot,
    warn,
  });
  const project = await readProjectConfigFile(options.projectRoot, warn);
  const merged = Object.create(null) as CustomAgentsConfig;
  for (const layer of [
    parseLayer(global.agents, 'config.json', warn),
    parseLayer(project?.agents, PROJECT_CONFIG_FILENAME, warn),
  ]) {
    for (const [id, value] of Object.entries(layer)) {
      if (value === null) delete merged[id];
      else merged[id] = { ...value };
    }
  }
  return merged;
}

async function readWritableProjectConfig(projectRoot: string): Promise<Record<string, unknown>> {
  const path = join(projectRoot, PROJECT_CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Cannot update ${PROJECT_CONFIG_FILENAME}: invalid JSON.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Cannot update ${PROJECT_CONFIG_FILENAME}: expected a JSON object.`);
  }
  return parsed;
}

async function writeProjectAgentLayer(
  projectRoot: string,
  update: (agents: Record<string, unknown>) => void,
): Promise<void> {
  const path = join(projectRoot, PROJECT_CONFIG_FILENAME);
  await withSerializedFileLock(`${path}.lock`, `custom-agents:${path}`, async () => {
    const config = await readWritableProjectConfig(projectRoot);
    const agents = Object.assign(
      Object.create(null) as Record<string, unknown>,
      isRecord(config.agents) ? config.agents : {},
    );
    update(agents);
    if (Object.keys(agents).length === 0) delete config.agents;
    else config.agents = agents;
    await writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
  });
}

/** Persist a project-level custom-agent override without disturbing other keys. */
export async function persistCustomAgent(
  projectRoot: string,
  definition: CustomAgentDefinition,
): Promise<void> {
  if (!isCanonicalCustomAgentId(definition.id)) {
    throw new Error(`Invalid custom agent id: ${definition.id}`);
  }
  await writeProjectAgentLayer(projectRoot, (agents) => {
    agents[definition.id] = {
      label: definition.label,
      startCommand: definition.startCommand,
      ...(definition.resumeCommand?.trim() === undefined || definition.resumeCommand.trim() === ''
        ? {}
        : { resumeCommand: definition.resumeCommand.trim() }),
    };
  });
}

/**
 * Remove a project agent. `null` deliberately masks a same-id global agent;
 * otherwise deleting a row in the UI would make it reappear after reload.
 */
export async function removeCustomAgent(projectRoot: string, id: string): Promise<void> {
  if (!isCanonicalCustomAgentId(id)) throw new Error(`Invalid custom agent id: ${id}`);
  await writeProjectAgentLayer(projectRoot, (agents) => {
    agents[id] = null;
  });
}
