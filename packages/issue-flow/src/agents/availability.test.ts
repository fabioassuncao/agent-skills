import { describe, expect, it } from 'vitest';
import {
  type AgentAvailability,
  clearAvailabilityCache,
  readinessFixture,
} from './availability.js';

describe('readiness inventory fixtures', () => {
  it('never reports authProbe:none providers as authentication confirmed', () => {
    const snapshot = readinessFixture();
    expect(snapshot.providers.claude.authentication).toBe('unverified');
    expect(snapshot.providers.claude.state).toBe('conditional');
    expect(snapshot.providers.antigravity.authentication).toBe('unverified');
    expect(snapshot.providers.antigravity.state).toBe('conditional');
    expect(snapshot.providers.codex.authentication).toBe('confirmed');
    expect(snapshot.providers.codex.state).toBe('ready');
  });

  it('maps legacy authenticated to attemptable, not confirmed', () => {
    clearAvailabilityCache();
    const entry = readinessFixture().providers.claude;
    const legacy: AgentAvailability = {
      id: entry.provider,
      installed: entry.installed,
      version: entry.version,
      authenticated: entry.installed && entry.authentication !== 'failed',
      authentication: entry.authentication,
      state: entry.state,
      detail: entry.detail,
      observedAt: entry.observedAt,
      expiresAt: entry.expiresAt,
      source: entry.source,
      cooldownUntil: entry.cooldownUntil,
    };
    expect(legacy.authenticated).toBe(true);
    expect(legacy.authentication).toBe('unverified');
  });
});
