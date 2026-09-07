import { z } from 'zod';
import { isCanonicalCustomAgentId } from '../agents/custom.js';
import {
  findRegisteredAgent,
  isBuiltInAgentId,
  listAgentDetails,
  normalizeCustomAgentId,
  validateCustomAgentInput,
} from '../agents/custom-registry.js';
import {
  loadCustomAgentsConfig,
  persistCustomAgent,
  removeCustomAgent,
} from '../config/custom-agents.js';
import type { ApiResponse } from './projects-api.js';

export interface AgentsApiProject {
  projectRoot: string;
}

export interface AgentsApiDeps {
  resolveProject(projectId: string | null): Promise<AgentsApiProject | null>;
  /** Server narrows this to false unless the actual listener is loopback. */
  writable: boolean;
}

const NOT_CONFIGURED: ApiResponse = {
  status: 501,
  body: { error: 'This monitor does not serve custom agents.' },
};

const NOT_WRITABLE: ApiResponse = {
  status: 403,
  body: { error: 'Custom agents can only be changed from a monitor bound to loopback.' },
};

function apiError(error: unknown): ApiResponse {
  return {
    status: 500,
    body: { error: error instanceof Error ? error.message : String(error) },
  };
}

const UpsertCustomAgentRequestSchema = z.object({
  label: z.string().trim().min(1),
  startCommand: z.string().trim().min(1),
  resumeCommand: z.string().trim().optional(),
});

function parseInput(
  body: unknown,
):
  | { ok: true; value: { label: string; startCommand: string; resumeCommand?: string } }
  | { ok: false; response: ApiResponse } {
  const parsed = UpsertCustomAgentRequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      response: {
        status: 400,
        body: { error: parsed.error.issues[0]?.message ?? 'Invalid custom agent.' },
      },
    };
  }
  const value = {
    label: parsed.data.label,
    startCommand: parsed.data.startCommand,
    ...(parsed.data.resumeCommand === undefined || parsed.data.resumeCommand === ''
      ? {}
      : { resumeCommand: parsed.data.resumeCommand }),
  };
  try {
    validateCustomAgentInput(value);
  } catch (error) {
    return {
      ok: false,
      response: {
        status: 400,
        body: { error: error instanceof Error ? error.message : String(error) },
      },
    };
  }
  return { ok: true, value };
}

async function project(
  deps: AgentsApiDeps | null,
  projectId: string | null,
): Promise<AgentsApiProject | ApiResponse> {
  if (deps === null) return NOT_CONFIGURED;
  return (await deps.resolveProject(projectId)) ?? NOT_CONFIGURED;
}

function isResponse(value: AgentsApiProject | ApiResponse): value is ApiResponse {
  return 'status' in value && 'body' in value;
}

/** GET /api/agents — safe on remote listeners because it never mutates state. */
export async function listAgentsRoute(
  deps: AgentsApiDeps | null,
  projectId: string | null,
): Promise<ApiResponse> {
  const resolved = await project(deps, projectId);
  if (isResponse(resolved)) return resolved;
  try {
    return {
      status: 200,
      body: {
        agents: deps?.writable
          ? listAgentDetails(await loadCustomAgentsConfig({ projectRoot: resolved.projectRoot }))
          : listAgentDetails(
              await loadCustomAgentsConfig({ projectRoot: resolved.projectRoot }),
            ).map((agent) => ({ ...agent, startCommand: null, resumeCommand: null })),
      },
    };
  } catch (error) {
    return apiError(error);
  }
}

/** POST /api/agents/validate — pure validation, so it is safe remotely. */
export function validateAgentRoute(body: unknown): ApiResponse {
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.response;
  return { status: 200, body: validateCustomAgentInput(parsed.value) };
}

export async function createAgentRoute(
  deps: AgentsApiDeps | null,
  projectId: string | null,
  body: unknown,
): Promise<ApiResponse> {
  if (deps === null) return NOT_CONFIGURED;
  if (!deps.writable) return NOT_WRITABLE;
  const resolved = await project(deps, projectId);
  if (isResponse(resolved)) return resolved;
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.response;
  const id = normalizeCustomAgentId(parsed.value.label);
  try {
    const current = await loadCustomAgentsConfig({ projectRoot: resolved.projectRoot });
    if (isBuiltInAgentId(id) || Object.hasOwn(current, id)) {
      return { status: 409, body: { error: `Agent already exists: ${id}` } };
    }
    await persistCustomAgent(resolved.projectRoot, { id, ...parsed.value });
    const custom = await loadCustomAgentsConfig({ projectRoot: resolved.projectRoot });
    const agent = listAgentDetails(custom).find((entry) => entry.id === id);
    return agent === undefined
      ? { status: 500, body: { error: `Created agent could not be loaded: ${id}` } }
      : { status: 200, body: { agent } };
  } catch (error) {
    return apiError(error);
  }
}

export async function updateAgentRoute(
  deps: AgentsApiDeps | null,
  projectId: string | null,
  id: string,
  body: unknown,
): Promise<ApiResponse> {
  if (deps === null) return NOT_CONFIGURED;
  if (!deps.writable) return NOT_WRITABLE;
  if (!isCanonicalCustomAgentId(id)) {
    return { status: 400, body: { error: `Invalid custom agent id: ${id}` } };
  }
  if (isBuiltInAgentId(id)) {
    return { status: 400, body: { error: `Built-in agent cannot be edited: ${id}` } };
  }
  const resolved = await project(deps, projectId);
  if (isResponse(resolved)) return resolved;
  const parsed = parseInput(body);
  if (!parsed.ok) return parsed.response;
  try {
    const current = await loadCustomAgentsConfig({ projectRoot: resolved.projectRoot });
    if (findRegisteredAgent(current, id)?.kind !== 'custom') {
      return { status: 404, body: { error: `Unknown agent: ${id}` } };
    }
    await persistCustomAgent(resolved.projectRoot, { id, ...parsed.value });
    const custom = await loadCustomAgentsConfig({ projectRoot: resolved.projectRoot });
    const agent = listAgentDetails(custom).find((entry) => entry.id === id);
    return agent === undefined
      ? { status: 500, body: { error: `Updated agent could not be loaded: ${id}` } }
      : { status: 200, body: { agent } };
  } catch (error) {
    return apiError(error);
  }
}

export async function deleteAgentRoute(
  deps: AgentsApiDeps | null,
  projectId: string | null,
  id: string,
): Promise<ApiResponse> {
  if (deps === null) return NOT_CONFIGURED;
  if (!deps.writable) return NOT_WRITABLE;
  if (!isCanonicalCustomAgentId(id)) {
    return { status: 400, body: { error: `Invalid custom agent id: ${id}` } };
  }
  if (isBuiltInAgentId(id)) {
    return { status: 400, body: { error: `Built-in agent cannot be deleted: ${id}` } };
  }
  const resolved = await project(deps, projectId);
  if (isResponse(resolved)) return resolved;
  try {
    const current = await loadCustomAgentsConfig({ projectRoot: resolved.projectRoot });
    if (!Object.hasOwn(current, id)) {
      return { status: 404, body: { error: `Unknown agent: ${id}` } };
    }
    await removeCustomAgent(resolved.projectRoot, id);
    return { status: 200, body: { ok: true } };
  } catch (error) {
    return apiError(error);
  }
}

export type AgentResourceMatch = { id: string } | { error: string } | null;

export function matchAgentResource(pathname: string): AgentResourceMatch {
  const match = /^\/api\/agents\/([^/]+)$/.exec(pathname);
  if (match === null) return null;
  try {
    const id = decodeURIComponent(match[1] as string);
    return isCanonicalCustomAgentId(id) ? { id } : { error: `Invalid custom agent id: ${id}` };
  } catch {
    return { error: 'Invalid percent-encoding in custom agent id.' };
  }
}
