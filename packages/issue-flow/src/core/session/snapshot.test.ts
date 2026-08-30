import { describe, expect, it } from 'vitest';
import { createInitialSnapshot } from '../session-state.js';

describe('createInitialSnapshot', () => {
  it('starts idle, read-only, with empty collections', () => {
    const snap = createInitialSnapshot();
    expect(snap.schemaVersion).toBe(1);
    expect(snap.status).toBe('idle');
    expect(snap.readOnly).toBe(true);
    expect(snap.capabilities).toEqual([]);
    expect(snap.phases).toEqual([]);
    expect(snap.logs).toEqual([]);
    expect(snap.startedAt).toBeNull();
  });

  it('starts the issue section with nothing reported', () => {
    expect(createInitialSnapshot().issue).toEqual({
      number: null,
      url: null,
      title: null,
      description: null,
      labels: [],
      state: null,
    });
  });

  it('starts every aggregate metric as null, never zero', () => {
    expect(createInitialSnapshot().metrics).toEqual({
      totalInputTokens: null,
      totalOutputTokens: null,
      totalCacheReadTokens: null,
      totalCacheCreationTokens: null,
      totalCostUsd: null,
    });
  });

  it('starts resilience observability with backward-compatible empty values', () => {
    expect(createInitialSnapshot().resilience).toEqual({
      attempt: 0,
      provider: null,
      model: null,
      lastFailureKind: null,
      cooldownUntil: null,
      lastActivityAt: null,
    });
  });
});
