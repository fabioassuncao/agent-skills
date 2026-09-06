import { describe, expect, it } from 'vitest';
import type { AgentPhase } from '../types.js';
import {
  assertSessionReuseAllowed,
  canReuseSession,
  PHASES_THAT_NEVER_REUSE_A_SESSION,
  SessionReuseError,
  selectReusableSession,
} from './reuse.js';
import type { AgentSession } from './types.js';
import { isFreeSession, isLiveSession } from './types.js';

/**
 * ADR-07 in test form.
 *
 * `review` and `pr-review` never continue an existing conversation, and there is
 * no configuration that changes it. A reviewer that continues the conversation
 * that wrote the code has already agreed with itself — reusing a session there
 * trades the meaning of "verified" for a context re-ingestion.
 */

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    runId: 'run-1',
    phase: 'execute',
    storyId: null,
    branch: 'feature',
    worktreeId: 'wt-1',
    provider: 'claude',
    conversationId: 'conv-1',
    status: 'idle',
    paneTarget: 'if-proj:if-feature.0',
    createdAt: '2026-09-06T10:00:00.000Z',
    updatedAt: '2026-09-06T10:00:00.000Z',
    endedAt: null,
    ...overrides,
  };
}

describe('canReuseSession', () => {
  it('names the phases whose independence is the point', () => {
    expect(PHASES_THAT_NEVER_REUSE_A_SESSION).toEqual(['review', 'pr-review']);
  });

  it('refuses reuse for review and pr-review', () => {
    expect(canReuseSession('review')).toBe(false);
    expect(canReuseSession('pr-review')).toBe(false);
  });

  it('allows it for the phases that produce work rather than judge it', () => {
    for (const phase of ['analyze', 'generate', 'prd', 'plan', 'execute', 'pr'] as AgentPhase[]) {
      expect(canReuseSession(phase)).toBe(true);
    }
  });

  it('allows it for a session with no phase at all', () => {
    expect(canReuseSession(null)).toBe(true);
  });
});

describe('assertSessionReuseAllowed', () => {
  // A configuration that asks for it is an error, not a preference to honour.
  it('throws for a phase that must stay independent', () => {
    expect(() => assertSessionReuseAllowed('review')).toThrow(SessionReuseError);
    expect(() => assertSessionReuseAllowed('review')).toThrow('not configurable');
    expect(() => assertSessionReuseAllowed('pr-review')).toThrow(SessionReuseError);
  });

  it('passes for every other phase', () => {
    expect(() => assertSessionReuseAllowed('execute')).not.toThrow();
    expect(() => assertSessionReuseAllowed(null)).not.toThrow();
  });
});

describe('selectReusableSession', () => {
  it('continues a live session on the same branch', () => {
    const existing = session();
    expect(
      selectReusableSession({ phase: 'execute', branch: 'feature', sessions: [existing] }),
    ).toBe(existing);
  });

  it('never continues anything for review, whatever is available', () => {
    expect(
      selectReusableSession({ phase: 'review', branch: 'feature', sessions: [session()] }),
    ).toBeNull();
    expect(
      selectReusableSession({ phase: 'pr-review', branch: 'feature', sessions: [session()] }),
    ).toBeNull();
  });

  it('ignores a session on another branch', () => {
    expect(
      selectReusableSession({
        phase: 'execute',
        branch: 'other',
        sessions: [session()],
      }),
    ).toBeNull();
  });

  // Without a conversation id there is nothing to resume; adopting the row
  // would start a fresh conversation while claiming continuity.
  it('ignores a session with no conversation to resume', () => {
    expect(
      selectReusableSession({
        phase: 'execute',
        branch: 'feature',
        sessions: [session({ conversationId: null })],
      }),
    ).toBeNull();
  });

  it('ignores a session the outside world has already contradicted', () => {
    expect(
      selectReusableSession({
        phase: 'execute',
        branch: 'feature',
        sessions: [session({ status: 'orphaned' })],
      }),
    ).toBeNull();
  });

  // A person opened it and is presumably still using it. A workflow taking it
  // over would interleave two conversations in one history.
  it('never lets the pipeline adopt a session a person opened', () => {
    const free = session({ runId: null, phase: null, storyId: null });
    expect(isFreeSession(free)).toBe(true);
    expect(
      selectReusableSession({ phase: 'execute', branch: 'feature', sessions: [free] }),
    ).toBeNull();
    // A free invocation may continue a free session — that is the same person
    // coming back to it.
    expect(selectReusableSession({ phase: null, branch: 'feature', sessions: [free] })).toBe(free);
  });

  it('takes the most recently touched when several qualify', () => {
    const older = session({ id: 'old', updatedAt: '2026-09-06T10:00:00.000Z' });
    const newer = session({ id: 'new', updatedAt: '2026-09-06T12:00:00.000Z' });
    expect(
      selectReusableSession({ phase: 'execute', branch: 'feature', sessions: [older, newer] })?.id,
    ).toBe('new');
  });
});

describe('session predicates', () => {
  it('recognises a session opened without a run, a phase or a story', () => {
    expect(isFreeSession(session())).toBe(false);
    expect(isFreeSession(session({ runId: null, phase: null, storyId: null }))).toBe(true);
    // A run with no phase is still a workflow session, not a free one.
    expect(isFreeSession(session({ phase: null, storyId: null }))).toBe(false);
  });

  it('recognises which sessions a caller could still talk to', () => {
    expect(isLiveSession(session({ status: 'starting' }))).toBe(true);
    expect(isLiveSession(session({ status: 'running' }))).toBe(true);
    expect(isLiveSession(session({ status: 'idle' }))).toBe(true);
    expect(isLiveSession(session({ status: 'stopped' }))).toBe(false);
    expect(isLiveSession(session({ status: 'orphaned' }))).toBe(false);
  });
});
