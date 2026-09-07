import { randomUUID } from 'node:crypto';
import {
  type ClaudeConversationGateway,
  createClaudeConversationGateway,
  toClaudeConversationState,
} from '../agents/session/claude.js';
import { CodexAppServerClient, type CodexAppServerGateway } from '../agents/session/codex.js';
import { toCodexConversationState } from '../agents/session/codex-conversation.js';
import type { ConversationState } from '../agents/session/conversation.js';
import {
  interruptAgentSession,
  listAgentSessions,
  sendToAgentSession,
} from '../agents/session/open.js';
import { projectAgentSessionTabs } from '../agents/session/tabs.js';
import type { AgentSession } from '../agents/session/types.js';
import type { StoredWorktree } from '../storage/db/repository.js';
import type { ApiResponse } from './projects-api.js';
import { listWorktreesRoute, type WorktreesApiDeps } from './worktrees-api.js';

export type ConversationApiDeps = WorktreesApiDeps & {
  claudeConversation?: ClaudeConversationGateway;
  codexConversation?: Pick<CodexAppServerGateway, 'threadRead' | 'turnStart' | 'turnInterrupt'>;
};

type ConversationTarget = {
  projectId: string;
  session: AgentSession;
  binding: StoredWorktree;
  cwd: string;
  control: Parameters<typeof sendToAgentSession>[0];
};

let codexClient: CodexAppServerClient | null = null;

function codexGateway(
  deps: ConversationApiDeps,
): Pick<CodexAppServerGateway, 'threadRead' | 'turnStart' | 'turnInterrupt'> {
  codexClient ??= new CodexAppServerClient();
  return deps.codexConversation ?? codexClient;
}

async function target(
  deps: ConversationApiDeps | null,
  projectId: string | null,
  branch: string,
): Promise<ConversationTarget | ApiResponse> {
  if (deps === null) {
    return { status: 501, body: { error: 'This monitor does not serve conversations.' } };
  }
  if (deps.writable !== true) {
    return { status: 403, body: { error: 'Conversations are available only on loopback.' } };
  }
  const project = await deps.resolveProject(projectId);
  if (project === null) {
    return { status: 404, body: { error: 'Project not found.' } };
  }
  const entry = (await project.deps.worktrees.list()).find(
    (candidate) => candidate.branch === branch && candidate.binding !== null,
  );
  const binding = entry?.binding ?? null;
  if (binding === null) {
    return { status: 404, body: { error: `Worktree not found: ${branch}` } };
  }
  const sessions = (await listAgentSessions(project.deps.storage, { branch })).filter(
    (session) => session.worktreeId === binding.worktreeId,
  );
  const session = projectAgentSessionTabs(sessions, binding).activeSession;
  if (session === null || session.conversationId === null) {
    return { status: 404, body: { error: `No conversation is attached to '${branch}'.` } };
  }
  if (session.provider !== 'claude' && session.provider !== 'codex') {
    return {
      status: 409,
      body: { error: `Agent '${session.provider}' has no structured conversation reader.` },
    };
  }
  return {
    projectId: project.projectId,
    session,
    binding,
    cwd: entry?.path ?? binding.path,
    control: project.deps,
  };
}

function isResponse(value: ConversationTarget | ApiResponse): value is ApiResponse {
  return 'body' in value;
}

async function readConversation(
  deps: ConversationApiDeps,
  selected: ConversationTarget,
): Promise<ConversationState> {
  const conversationId = selected.session.conversationId as string;
  if (selected.session.provider === 'codex') {
    const response = await codexGateway(deps).threadRead(conversationId, true);
    return toCodexConversationState(response.thread);
  }
  const gateway = deps.claudeConversation ?? createClaudeConversationGateway();
  const recorded = await gateway.readSession(conversationId, selected.cwd);
  const state = toClaudeConversationState(recorded, {
    conversationId,
    cwd: selected.cwd,
  });
  if (selected.session.status !== 'running') return state;
  return {
    ...state,
    running: true,
    activeTurnId: state.messages.at(-1)?.turnId ?? null,
  };
}

async function worktreeSummary(
  deps: ConversationApiDeps,
  projectId: string | null,
  branch: string,
): Promise<Record<string, unknown> | null> {
  const response = await listWorktreesRoute(deps, projectId);
  if (response.status !== 200) return null;
  const rows = (response.body as { worktrees?: Array<Record<string, unknown>> }).worktrees ?? [];
  return rows.find((row) => row.branch === branch) ?? null;
}

export function matchConversationRoute(
  pathname: string,
): { branch: string; action: 'attach' | 'history' | 'messages' | 'interrupt' } | null {
  const match = /^\/api\/agents\/worktrees\/([^/]+)\/(attach|history|messages|interrupt)$/.exec(
    pathname,
  );
  if (match?.[1] === undefined || match[2] === undefined) return null;
  try {
    return {
      branch: decodeURIComponent(match[1]),
      action: match[2] as 'attach' | 'history' | 'messages' | 'interrupt',
    };
  } catch {
    return null;
  }
}

export async function conversationStateRoute(
  deps: ConversationApiDeps | null,
  projectId: string | null,
  branch: string,
): Promise<ApiResponse> {
  try {
    const selected = await target(deps, projectId, branch);
    if (isResponse(selected)) return selected;
    const [conversation, worktree] = await Promise.all([
      readConversation(deps as ConversationApiDeps, selected),
      worktreeSummary(deps as ConversationApiDeps, projectId, branch),
    ]);
    if (worktree === null) {
      return { status: 404, body: { error: `Worktree not found: ${branch}` } };
    }
    return { status: 200, body: { worktree, conversation } };
  } catch (error) {
    return { status: 502, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

export async function sendConversationMessageRoute(
  deps: ConversationApiDeps | null,
  projectId: string | null,
  branch: string,
  body: unknown,
): Promise<ApiResponse> {
  const text =
    body !== null &&
    typeof body === 'object' &&
    typeof (body as { text?: unknown }).text === 'string'
      ? (body as { text: string }).text.trim()
      : '';
  if (text === '') return { status: 400, body: { error: 'Message text is required.' } };
  try {
    const selected = await target(deps, projectId, branch);
    if (isResponse(selected)) return selected;
    const conversationId = selected.session.conversationId as string;
    if (selected.session.provider === 'codex') {
      const response = await codexGateway(deps as ConversationApiDeps).turnStart({
        threadId: conversationId,
        cwd: selected.cwd,
        input: [{ type: 'text', text }],
      });
      return {
        status: 200,
        body: {
          conversationId,
          turnId: response.turn.id,
          running: true,
        },
      };
    }
    await sendToAgentSession(selected.control, selected.session, text);
    return {
      status: 200,
      body: { conversationId, turnId: randomUUID(), running: true },
    };
  } catch (error) {
    return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

export async function interruptConversationRoute(
  deps: ConversationApiDeps | null,
  projectId: string | null,
  branch: string,
): Promise<ApiResponse> {
  try {
    const selected = await target(deps, projectId, branch);
    if (isResponse(selected)) return selected;
    const conversation = await readConversation(deps as ConversationApiDeps, selected);
    if (conversation.activeTurnId === null) {
      return { status: 409, body: { error: 'The conversation has no active turn.' } };
    }
    if (selected.session.provider === 'codex') {
      await codexGateway(deps as ConversationApiDeps).turnInterrupt({
        threadId: conversation.conversationId,
        turnId: conversation.activeTurnId,
      });
    } else {
      await interruptAgentSession(selected.control, selected.session);
    }
    return {
      status: 200,
      body: {
        conversationId: conversation.conversationId,
        turnId: conversation.activeTurnId,
        interrupted: true,
      },
    };
  } catch (error) {
    return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}
