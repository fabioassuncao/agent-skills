import { describe, expect, it } from 'vitest';
import { agentIconVisible, agentStatusLabel } from './AgentStatusIcon.svelte';

/**
 * PORT of `frontend/src/lib/AgentStatusIcon.test.ts` @ d8c9d5f — 3 cases, plus
 * 1 for the closed vocabulary §50.3 merges into this component.
 */

describe('agentIconVisible', () => {
  it('is visible for working, waiting and error regardless of unread', () => {
    expect(agentIconVisible('working', false)).toBe(true);
    expect(agentIconVisible('waiting', false)).toBe(true);
    expect(agentIconVisible('error', false)).toBe(true);
  });

  it('is visible for done only when unread', () => {
    expect(agentIconVisible('done', true)).toBe(true);
    expect(agentIconVisible('done', false)).toBe(false);
  });

  it('is hidden for idle and unknown statuses', () => {
    expect(agentIconVisible('idle', true)).toBe(false);
    expect(agentIconVisible('', false)).toBe(false);
  });
});

describe('agentStatusLabel', () => {
  it('uses one term per concept, and falls back inside the closed vocabulary', () => {
    expect(agentStatusLabel('working')).toBe('executando');
    expect(agentStatusLabel('waiting')).toBe('aguardando');
    expect(agentStatusLabel('done')).toBe('concluído');
    expect(agentStatusLabel('error')).toBe('falhou');
    // An unknown status must not leak a raw backend word onto a badge.
    expect(agentStatusLabel('something-new')).toBe('aguardando');
  });
});
