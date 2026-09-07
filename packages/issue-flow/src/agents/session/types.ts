import type { AgentPermission, AgentPhase } from '../types.js';

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
