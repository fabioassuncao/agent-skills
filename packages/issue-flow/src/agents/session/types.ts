import type { AgentPermission, AgentPhase } from '../types.js';

/**
 * The durable half of an agent session.
 *
 * §27 of the absorption plan separates seven concepts that are easy to conflate.
 * This is one of them, and the definition is narrow on purpose:
 *
 * - the **`AgentConversation`** — the model's history — is owned by the
 *   provider, on disk under `~/.claude` or `~/.codex`. This project never
 *   copies it and never parses it to reconstruct state.
 * - the **`RuntimeSession`** — worktree, ports, services, container — is owned
 *   by `src/runtime/`.
 * - the **`tmux` session** is owned by the multiplexer and is ephemeral.
 * - an **`AgentSession`**, this, is the *link* between a conversation and what
 *   it is being used for, plus whether it is alive. It is the only one of the
 *   four this project persists, and it exists so that reopening a worktree can
 *   resume the same conversation instead of starting a new one.
 *
 * `runId`, `phase` and `storyId` are **nullable** (ADR-16). A session opened
 * without an issue, a plan or a workflow is the same entity with those fields
 * empty — which is what makes a free session possible without inventing a
 * second execution model.
 */

export type AgentSessionStatus = 'starting' | 'running' | 'idle' | 'stopped' | 'orphaned';

export interface AgentSession {
  /** Issue Flow's own id for the link. Never the provider's. */
  id: string;
  /** Run this session belongs to. `null` for a free session. */
  runId: string | null;
  /** Phase it was opened for. `null` for a free session. */
  phase: AgentPhase | null;
  /** Story it is working on. `null` when it is not story-scoped. */
  storyId: string | null;
  branch: string;
  /** Worktree it runs in. `null` in `headless`, which has no worktree. */
  worktreeId: string | null;
  /** Built-in provider id or a custom-agent id from the layered config. */
  provider: string;
  /** Semantic permission fixed when the session is first opened. */
  permission: AgentPermission;
  /**
   * The provider's own conversation id.
   *
   * `null` until the provider reports one. It is what `--resume` takes, so a
   * session without it can be reopened but not continued.
   */
  conversationId: string | null;
  status: AgentSessionStatus;
  /** `session:window.pane`. `null` when the session is not in a pane. */
  paneTarget: string | null;
  /** Durable nonce mirrored into tmux's per-pane owner option. */
  paneToken: string | null;
  /**
   * Root session this tab was forked from. `null` is the root tab.
   *
   * This is Issue Flow session identity, never a provider conversation id.
   */
  parentSessionId: string | null;
  /** Stable tab order; null marks a pre-tabs/non-tab historical row. Root is zero. */
  tabSequence: number | null;
  /**
   * What to call this session in a list.
   *
   * A workflow session is named by its issue; a free session has no issue, so
   * without this the only things left to show are a uuid and a generated
   * branch. It is a caption and nothing else — nothing is ever looked up by it.
   */
  label: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

/** A session with no run, phase or story: opened directly by a person. */
export function isFreeSession(session: AgentSession): boolean {
  return session.runId === null && session.phase === null && session.storyId === null;
}

/**
 * How to describe a session in one line.
 *
 * The label when there is one, the branch otherwise — never the id, which says
 * nothing to the person reading it.
 */
export function describeSession(session: AgentSession): string {
  const label = session.label?.trim();
  return label === undefined || label === '' ? session.branch : label;
}

/** Whether the session is one a caller could still talk to. */
export function isLiveSession(session: AgentSession): boolean {
  return session.status === 'starting' || session.status === 'running' || session.status === 'idle';
}
