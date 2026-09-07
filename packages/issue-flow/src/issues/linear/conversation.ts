import {
  createClaudeConversationGateway,
  toClaudeConversationState,
} from '../../agents/session/claude.js';
import { CodexAppServerClient } from '../../agents/session/codex.js';
import { toCodexConversationState } from '../../agents/session/codex-conversation.js';
import type { ResolvedAgentSessionContext } from '../../agents/session/context.js';
import type { ConversationState } from '../../agents/session/conversation.js';
import {
  buildConversationExportPayload,
  type ConversationExportPayload,
  renderConversationAsMarkdown,
} from '../../agents/session/export.js';
import { listAgentSessions } from '../../agents/session/open.js';

export const LINEAR_CONVERSATION_READ_TIMEOUT_MS = 15_000;

/** Read one Codex thread with a bounded lifetime and always release the app-server process. */
export async function readCodexConversationWithDeadline(
  client: Pick<CodexAppServerClient, 'threadRead' | 'close'>,
  conversationId: string,
  timeoutMs = LINEAR_CONVERSATION_READ_TIMEOUT_MS,
): Promise<ConversationState> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const response = await Promise.race([
      client.threadRead(conversationId, true),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(Object.assign(new Error('Codex conversation read timed out.'), { status: 504 })),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
    return toCodexConversationState(response.thread);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    client.close();
  }
}

export interface WorktreeConversationExport {
  markdown: string;
  attachment: ConversationExportPayload;
}

export async function readWorktreeConversationExport(
  context: ResolvedAgentSessionContext,
  branch: string,
): Promise<WorktreeConversationExport> {
  const worktree = (await context.worktrees.list()).find(
    (entry) => entry.branch === branch && entry.entry !== null,
  );
  if (worktree === undefined) {
    throw Object.assign(new Error(`Worktree not found: ${branch}`), { status: 404 });
  }
  const session = (await listAgentSessions(context.storage, { branch }))[0];
  if (session === undefined || session.conversationId === null) {
    throw Object.assign(new Error(`No recorded conversation for worktree: ${branch}`), {
      status: 409,
    });
  }

  let conversation: ConversationState;
  if (session.provider === 'claude') {
    const stored = await createClaudeConversationGateway().readSession(
      session.conversationId,
      worktree.path,
    );
    if (stored === null) {
      throw Object.assign(new Error('The Claude conversation is not available on disk.'), {
        status: 409,
      });
    }
    conversation = toClaudeConversationState(stored, {
      conversationId: session.conversationId,
      cwd: worktree.path,
    });
  } else if (session.provider === 'codex') {
    const client = new CodexAppServerClient({ clientName: 'issue-flow-linear-export' });
    conversation = await readCodexConversationWithDeadline(client, session.conversationId);
  } else {
    throw Object.assign(
      new Error(`Agent '${session.provider}' does not expose structured conversation history.`),
      { status: 409 },
    );
  }

  return {
    markdown: renderConversationAsMarkdown(conversation),
    attachment: buildConversationExportPayload({
      branch,
      baseBranch: worktree.binding?.baseBranch ?? null,
      agent: worktree.binding?.agent ?? session.provider,
      conversation,
    }),
  };
}
