import { z } from 'zod';
import type { ResolvedAgentSessionContext } from '../agents/session/context.js';
import {
  linearApiKey,
  loadAutoNameConfig,
  loadGitHubConfig,
  loadLinearConfig,
  persistGitHubAutoRemoveOnMerge,
  persistLinearAutoCreate,
} from '../config.js';
import {
  AUTO_NAME_MAX_LENGTH,
  AUTO_NAME_TIMEOUT_MS,
  autoNameSystemPrompt,
} from '../conventions/git/auto-name.js';
import type { WorktreeConversationExport } from '../issues/linear/conversation.js';
import {
  createLinearClient,
  type LinearClient,
  type LinearTarget,
  readWorktreeConversationExport,
  redactLinearError,
  redactLinearPayload,
} from '../issues/linear/index.js';
import type { ApiResponse } from './projects-api.js';

export interface IntegrationsApiDeps {
  writable?: boolean;
  env?: NodeJS.ProcessEnv;
  resolveRuntime: (projectId: string | null) => Promise<ResolvedAgentSessionContext | null>;
  createLinearClient?: (apiKey: string) => LinearClient;
  readConversation?: (
    context: ResolvedAgentSessionContext,
    branch: string,
  ) => Promise<WorktreeConversationExport>;
}

const NOT_CONFIGURED: ApiResponse = {
  status: 501,
  body: { error: 'This monitor does not serve project integrations.' },
};
const NOT_WRITABLE: ApiResponse = {
  status: 403,
  body: { error: 'Project integrations can only be changed from a loopback monitor.' },
};
const toggleSchema = z.object({ enabled: z.boolean() });
const postSchema = z.object({
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('issue'), issueId: z.string().trim().min(1) }),
    z.object({
      kind: z.literal('team'),
      teamKey: z
        .string()
        .trim()
        .regex(/^[A-Za-z][A-Za-z0-9]*$/),
      title: z.string().trim().min(1).optional(),
    }),
  ]),
});

function invalid(error: z.ZodError): ApiResponse {
  return { status: 400, body: { error: error.issues[0]?.message ?? 'Invalid request body.' } };
}

function failure(error: unknown, fallbackStatus = 500): ApiResponse {
  const status = (error as { status?: unknown })?.status;
  return {
    status: typeof status === 'number' ? status : fallbackStatus,
    body: { error: error instanceof Error ? error.message : String(error) },
  };
}

async function context(
  deps: IntegrationsApiDeps | null,
  projectId: string | null,
): Promise<ResolvedAgentSessionContext | ApiResponse> {
  if (deps === null) return NOT_CONFIGURED;
  return (await deps.resolveRuntime(projectId)) ?? NOT_CONFIGURED;
}

function isResponse(value: ResolvedAgentSessionContext | ApiResponse): value is ApiResponse {
  return 'status' in value && 'body' in value;
}

function writable(deps: IntegrationsApiDeps | null): ApiResponse | null {
  if (deps === null) return NOT_CONFIGURED;
  return deps.writable === true ? null : NOT_WRITABLE;
}

function client(deps: IntegrationsApiDeps, key: string): LinearClient {
  return deps.createLinearClient?.(key) ?? createLinearClient({ apiKey: key });
}

function environment(deps: IntegrationsApiDeps | null): NodeJS.ProcessEnv {
  return deps?.env ?? process.env;
}

export async function listLinearIssuesRoute(
  deps: IntegrationsApiDeps | null,
  projectId: string | null,
): Promise<ApiResponse> {
  const resolved = await context(deps, projectId);
  if (isResponse(resolved)) return resolved;
  const config = await loadLinearConfig({
    projectRoot: resolved.projectRoot,
    env: deps?.env,
  });
  if (!config.enabled) return { status: 200, body: { availability: 'disabled', issues: [] } };
  const key = linearApiKey(deps?.env);
  if (key === null) {
    return { status: 200, body: { availability: 'missing_api_key', issues: [] } };
  }
  try {
    return {
      status: 200,
      body: {
        availability: 'ready',
        issues: redactLinearPayload(await client(deps!, key).fetchAssignedIssues(), key),
      },
    };
  } catch (error) {
    return failure(new Error(redactLinearError(error, key)), 502);
  }
}

export async function setLinearAutoCreateRoute(
  deps: IntegrationsApiDeps | null,
  projectId: string | null,
  body: unknown,
): Promise<ApiResponse> {
  const blocked = writable(deps);
  if (blocked !== null) return blocked;
  if (environment(deps).ISSUE_FLOW_LINEAR_AUTO_CREATE !== undefined) {
    return {
      status: 409,
      body: { error: 'Linear auto-create is pinned by ISSUE_FLOW_LINEAR_AUTO_CREATE.' },
    };
  }
  const parsed = toggleSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);
  const resolved = await context(deps, projectId);
  if (isResponse(resolved)) return resolved;
  try {
    await persistLinearAutoCreate(resolved.projectRoot, parsed.data.enabled);
    return { status: 200, body: { ok: true, enabled: parsed.data.enabled } };
  } catch (error) {
    return failure(error);
  }
}

export async function setAutoRemoveOnMergeRoute(
  deps: IntegrationsApiDeps | null,
  projectId: string | null,
  body: unknown,
): Promise<ApiResponse> {
  const blocked = writable(deps);
  if (blocked !== null) return blocked;
  if (environment(deps).ISSUE_FLOW_GITHUB_AUTO_REMOVE_ON_MERGE !== undefined) {
    return {
      status: 409,
      body: {
        error: 'GitHub auto-remove is pinned by ISSUE_FLOW_GITHUB_AUTO_REMOVE_ON_MERGE.',
      },
    };
  }
  const parsed = toggleSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);
  const resolved = await context(deps, projectId);
  if (isResponse(resolved)) return resolved;
  try {
    await persistGitHubAutoRemoveOnMerge(resolved.projectRoot, parsed.data.enabled);
    return { status: 200, body: { ok: true, enabled: parsed.data.enabled } };
  } catch (error) {
    return failure(error);
  }
}

export async function autoNameConfigRoute(
  deps: IntegrationsApiDeps | null,
  projectId: string | null,
): Promise<ApiResponse> {
  const resolved = await context(deps, projectId);
  if (isResponse(resolved)) return resolved;
  const config = await loadAutoNameConfig({ projectRoot: resolved.projectRoot });
  return {
    status: 200,
    body: {
      autoName:
        config === null
          ? null
          : {
              maxLength: config.maxLength ?? AUTO_NAME_MAX_LENGTH,
              timeoutMs: config.timeoutMs ?? AUTO_NAME_TIMEOUT_MS,
              systemPrompt: autoNameSystemPrompt(config),
            },
    },
  };
}

export async function postWorktreeToLinearRoute(
  deps: IntegrationsApiDeps | null,
  projectId: string | null,
  branch: string,
  body: unknown,
): Promise<ApiResponse> {
  const blocked = writable(deps);
  if (blocked !== null) return blocked;
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);
  const resolved = await context(deps, projectId);
  if (isResponse(resolved)) return resolved;
  const config = await loadLinearConfig({ projectRoot: resolved.projectRoot, env: deps?.env });
  if (!config.enabled) return { status: 400, body: { error: 'Linear integration is disabled.' } };
  const key = linearApiKey(deps?.env);
  if (key === null) return { status: 503, body: { error: 'LINEAR_API_KEY is not set.' } };
  try {
    const conversation = await (deps?.readConversation ?? readWorktreeConversationExport)(
      resolved,
      branch,
    );
    const result = redactLinearPayload(
      await client(deps!, key).postConversation(parsed.data.target as LinearTarget, {
        branch,
        ...conversation,
      }),
      key,
    );
    return { status: 200, body: { ok: true, ...result } };
  } catch (error) {
    return failure(new Error(redactLinearError(error, key)), 502);
  }
}

/** Used by the project config response so settings and the scheduler agree. */
export async function resolvedIntegrationSettings(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  linearAvailability: 'disabled' | 'missing_api_key' | 'ready';
  linearAutoCreateWorktrees: boolean;
  autoRemoveOnMerge: boolean;
}> {
  const [linear, github] = await Promise.all([
    loadLinearConfig({ projectRoot, env }),
    loadGitHubConfig({ projectRoot, env }),
  ]);
  return {
    linearAvailability: !linear.enabled
      ? 'disabled'
      : linearApiKey(env) === null
        ? 'missing_api_key'
        : 'ready',
    linearAutoCreateWorktrees: linear.autoCreateWorktrees,
    autoRemoveOnMerge: github.autoRemoveOnMerge,
  };
}
