import { findRegisteredAgent } from '../agents/custom-registry.js';
import {
  AgentSessionError,
  interruptAgentSession,
  listAgentSessions,
  openAgentSession,
  sendToAgentSession,
  stopAgentSession,
} from '../agents/session/open.js';
import { linkSessionToRun, loadSession } from '../agents/session/store.js';
import { type AgentSession, isFreeSession } from '../agents/session/types.js';
import type { AgentPermission } from '../agents/types.js';
import { loadCustomAgentsConfig } from '../config/custom-agents.js';
import type { ServiceSpec } from '../runtime/services.js';
import { findLatestRunIdForIssue } from '../storage/db/repository.js';
import type { ApiResponse } from './projects-api.js';

/**
 * The agent-session surface: `/api/agent-sessions` and the verbs of §49.3.
 *
 * **Why not `GET /api/sessions`.** That path already exists and answers the
 * list of *pipeline executions* — it has answered that since the multi-session
 * dashboard, `web/AGENTS.md` documents it, and the pushed `sessions` frame on
 * `/api/stream` is built from the same payload. ADR-20 is explicit that an
 * execution and a session are different things, so serving both under one path
 * would be the conflation the ADR exists to prevent, and changing what the
 * existing path returns would break every client of it. The other verbs of
 * §49.3 do not collide and are accepted on both spellings; only the listing had
 * to choose, and it chose the name that says which of the two it means.
 *
 * ADAPT of the upstream's worktree routes (`backend/src/server.ts` @ d8c9d5f),
 * with the same shape `projects-api.ts` uses: handlers return `{ status, body }`
 * instead of writing to a `ServerResponse`, so the whole surface is testable
 * without a socket.
 *
 * Every mutating route requires a loopback binding, exactly like the
 * configuration writes and the project writes: opening a session starts a
 * process on the machine, and typing into one is a remote shell (ADR-10).
 */

/** What the server hands this module for one project. */
export interface SessionsApiProject {
  projectId: string;
  /** Everything `openAgentSession` needs. Built per project by the server. */
  deps: Parameters<typeof openAgentSession>[0];
  /**
   * Services declared by the project (§19), for the health probe `web/worktrees-api.ts`
   * runs per session. Resolved once with the rest of the project wiring.
   */
  services: readonly ServiceSpec[];
}

export interface SessionsApiDeps {
  /**
   * Resolve the project a request addresses.
   *
   * `null` for a monitor with no project surface at all, which then answers an
   * empty list rather than 404 — one dashboard build has to serve both.
   */
  resolveProject(projectId: string | null): Promise<SessionsApiProject | null>;
  /**
   * Every project this monitor serves, for the consolidated view of §49.4.
   *
   * "Trabalho ativo" answers "what is running anywhere", and a per-project
   * listing cannot: the dashboard would have to ask N times and would not know
   * what N was. Absent leaves the consolidated listing empty rather than
   * guessing, which is the honest answer for a monitor with one project.
   */
  listProjects?(): Promise<readonly SessionsApiProject[]>;
  /** Whether mutating routes are enabled. Loopback only (ADR-10). */
  writable: boolean;
}

const NOT_CONFIGURED: ApiResponse = {
  status: 501,
  body: { error: 'This monitor does not serve agent sessions.' },
};

const NOT_WRITABLE: ApiResponse = {
  status: 403,
  body: { error: 'Agent sessions can only be opened from a monitor bound to loopback.' },
};

/** The wire shape of a session. Additive over the row: nothing is hidden. */
export function sessionPayload(session: AgentSession, projectId?: string): Record<string, unknown> {
  return {
    ...session,
    // Present only on the consolidated listing, where a row has to say which
    // repository it belongs to before it can be grouped by one (§49.4).
    ...(projectId === undefined ? {} : { projectId }),
    // Said explicitly rather than left to the client to infer from three nulls:
    // a dashboard grouping "Active work" needs to know which of the two modes
    // a row is (§49.4), and re-deriving it in every client is how the two
    // definitions drift apart.
    free: isFreeSession(session),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

const PERMISSIONS: readonly AgentPermission[] = ['read-only', 'workspace', 'autonomous'];

function toApiResponse(error: unknown): ApiResponse {
  if (error instanceof AgentSessionError) {
    return { status: error.status, body: { error: error.message } };
  }
  const status = (error as { status?: unknown })?.status;
  const message = error instanceof Error ? error.message : String(error);
  return { status: typeof status === 'number' ? status : 500, body: { error: message } };
}

/** `GET /api/agent-sessions[?free=1]`. */
export async function listSessionsRoute(
  deps: SessionsApiDeps | null,
  projectId: string | null,
  options: { freeOnly?: boolean; allProjects?: boolean } = {},
): Promise<ApiResponse> {
  if (deps === null) return { status: 200, body: [] };

  const projects =
    options.allProjects === true
      ? ((await deps.listProjects?.()) ?? [])
      : await deps.resolveProject(projectId).then((one) => (one === null ? [] : [one]));

  const rows: Record<string, unknown>[] = [];
  for (const project of projects) {
    const sessions = await listAgentSessions(project.deps.storage).catch(() => []);
    const filtered = options.freeOnly === true ? sessions.filter(isFreeSession) : sessions;
    for (const session of filtered) rows.push(sessionPayload(session, project.projectId));
  }
  return { status: 200, body: rows };
}

/**
 * `POST /api/sessions` — open one.
 *
 * `issueRef` is what unifies the two modes on one route (§49.3): present, the
 * session belongs to that issue's run; absent, it belongs to nobody and the
 * three columns stay empty. Present-but-unknown is refused rather than silently
 * downgraded to a free session — a caller that asked for issue 42 and got a
 * scratch session would not find out until the work was done.
 */
export async function createSessionRoute(
  deps: SessionsApiDeps | null,
  projectId: string | null,
  body: unknown,
): Promise<ApiResponse> {
  if (deps === null) return NOT_CONFIGURED;
  if (!deps.writable) return NOT_WRITABLE;
  const project = await deps.resolveProject(projectId);
  if (project === null) return NOT_CONFIGURED;

  const input = record(body);
  const agent = optionalString(input.agent) ?? 'claude';
  const registered = findRegisteredAgent(
    await loadCustomAgentsConfig({ projectRoot: project.deps.projectRoot }),
    agent,
  );
  if (registered === null) {
    return { status: 400, body: { error: `Unknown agent '${agent}'.` } };
  }
  const permissionRaw = optionalString(input.permission) ?? 'workspace';
  if (!PERMISSIONS.includes(permissionRaw as AgentPermission)) {
    return {
      status: 400,
      body: {
        error: `Unknown permission '${permissionRaw}'. Use one of: ${PERMISSIONS.join(', ')}.`,
      },
    };
  }

  const issueRef = optionalString(input.issueRef);
  let runId: string | null = null;
  if (issueRef !== undefined) {
    runId = await findLatestRunIdForIssue({ ...project.deps.storage, issueId: issueRef });
    if (runId === null) {
      return {
        status: 409,
        body: {
          error: `Issue ${issueRef} has no run to attach a session to yet. Start one first, or open a session with no issueRef.`,
        },
      };
    }
  }

  try {
    const opened = await openAgentSession(project.deps, {
      provider: agent,
      ...(registered.kind === 'custom' ? { customAgent: registered } : {}),
      permission: permissionRaw as AgentPermission,
      ...(optionalString(input.branch) === undefined
        ? {}
        : { branch: optionalString(input.branch) as string }),
      ...(optionalString(input.label) === undefined
        ? {}
        : { label: optionalString(input.label) as string }),
      ...(optionalString(input.prompt) === undefined
        ? {}
        : { prompt: optionalString(input.prompt) as string }),
      ...(optionalString(input.model) === undefined
        ? {}
        : { model: optionalString(input.model) as string }),
      ...(runId === null ? {} : { runId }),
    });
    return {
      status: 201,
      body: {
        session: sessionPayload(opened.session),
        branch: opened.branch,
        worktreePath: opened.worktreePath,
        paneTarget: opened.paneTarget,
        launchMode: opened.launchMode,
        layout: opened.layout,
        // What a client needs to open the terminal on this session without a
        // second round trip: the transport takes a branch, not a pane.
        terminal: { path: '/ws/terminal', branch: opened.branch },
      },
    };
  } catch (error) {
    return toApiResponse(error);
  }
}

async function withSession(
  deps: SessionsApiDeps | null,
  projectId: string | null,
  sessionId: string,
  handler: (project: SessionsApiProject, session: AgentSession) => Promise<ApiResponse>,
): Promise<ApiResponse> {
  if (deps === null) return NOT_CONFIGURED;
  if (!deps.writable) return NOT_WRITABLE;
  const project = await deps.resolveProject(projectId);
  if (project === null) return NOT_CONFIGURED;

  const session = await loadSession(project.deps.storage, sessionId);
  if (session === null) {
    return { status: 404, body: { error: `No session with id '${sessionId}'.` } };
  }
  try {
    return await handler(project, session);
  } catch (error) {
    return toApiResponse(error);
  }
}

/** `POST /api/sessions/:id/input` — a subsequent turn. */
export function sendSessionInputRoute(
  deps: SessionsApiDeps | null,
  projectId: string | null,
  sessionId: string,
  body: unknown,
): Promise<ApiResponse> {
  return withSession(deps, projectId, sessionId, async (project, session) => {
    const text = record(body).text;
    if (typeof text !== 'string' || text === '') {
      return { status: 400, body: { error: 'Pass { "text": "…" }.' } };
    }
    await sendToAgentSession(project.deps, session, text);
    return { status: 202, body: { sessionId: session.id, delivered: text.length } };
  });
}

/** `POST /api/sessions/:id/interrupt` — Ctrl-C, nothing more. */
export function interruptSessionRoute(
  deps: SessionsApiDeps | null,
  projectId: string | null,
  sessionId: string,
): Promise<ApiResponse> {
  return withSession(deps, projectId, sessionId, async (project, session) => {
    await interruptAgentSession(project.deps, session);
    return { status: 202, body: { sessionId: session.id, interrupted: true } };
  });
}

/** `DELETE /api/sessions/:id` — stop it. The worktree survives by default. */
export function stopSessionRoute(
  deps: SessionsApiDeps | null,
  projectId: string | null,
  sessionId: string,
  options: { removeWorktree?: boolean } = {},
): Promise<ApiResponse> {
  return withSession(deps, projectId, sessionId, async (project, session) => {
    const stopped = await stopAgentSession(project.deps, session, {
      ...(options.removeWorktree === undefined ? {} : { removeWorktree: options.removeWorktree }),
    });
    return { status: 200, body: sessionPayload(stopped) };
  });
}

/**
 * `POST /api/sessions/:id/link` — promote a free session to a run.
 *
 * The HTTP twin of `issue-flow session link`, and it refuses for the same
 * reason: the run has to exist. A route that created one would be a session
 * starting the pipeline (§49.2).
 */
export function linkSessionRoute(
  deps: SessionsApiDeps | null,
  projectId: string | null,
  sessionId: string,
  body: unknown,
): Promise<ApiResponse> {
  return withSession(deps, projectId, sessionId, async (project, session) => {
    if (!isFreeSession(session)) {
      return {
        status: 409,
        body: { error: `Session ${session.id} already belongs to run ${session.runId ?? '?'}.` },
      };
    }

    const input = record(body);
    const issueRef = optionalString(input.issueRef);
    let runId = optionalString(input.runId) ?? null;
    if (runId === null && issueRef !== undefined) {
      runId = await findLatestRunIdForIssue({ ...project.deps.storage, issueId: issueRef });
    }
    if (runId === null) {
      return {
        status: 409,
        body: {
          error:
            issueRef === undefined
              ? 'Pass { "issueRef": "42" } or { "runId": "…" }.'
              : `Issue ${issueRef} has no run to link to yet.`,
        },
      };
    }

    const linked = await linkSessionToRun(project.deps.storage, session, runId);
    return { status: 200, body: sessionPayload(linked) };
  });
}

/** Match `/api/(agent-)?sessions/:id[/action]`, returning the two segments. */
export function matchSessionResource(
  pathname: string,
): { sessionId: string; action: string | null } | null {
  const match = /^\/api\/(?:agent-)?sessions\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  if (match === null) return null;
  return { sessionId: decodeURIComponent(match[1] as string), action: match[2] ?? null };
}
