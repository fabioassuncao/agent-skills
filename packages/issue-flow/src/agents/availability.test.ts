import { describe, expect, it } from 'vitest';
import { readinessFixture } from './availability.js';

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
});
