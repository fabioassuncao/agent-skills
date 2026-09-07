import { describe, expect, it } from 'vitest';
import { deriveProjectPrefix, RESERVED_PROJECT_PREFIXES, sanitizeProjectPrefix } from './prefix.js';

/**
 * Ported from `backend/src/__tests__/domain-policies.test.ts` @ d8c9d5f
 * (`sanitizeProjectPrefix` + `deriveProjectPrefix`: 8 cases), plus the two
 * cases the widened reserved list and the Windows separator introduce here.
 */
describe('sanitizeProjectPrefix', () => {
  it('lowercases and replaces non-alphanumerics with hyphens', () => {
    expect(sanitizeProjectPrefix('My Project')).toBe('my-project');
    expect(sanitizeProjectPrefix('Some_Repo.v2')).toBe('some-repo-v2');
  });

  it('collapses runs of hyphens and trims edges', () => {
    expect(sanitizeProjectPrefix('--__foo bar__--')).toBe('foo-bar');
  });

  it('returns an empty string when nothing usable remains', () => {
    expect(sanitizeProjectPrefix('***')).toBe('');
  });
});

describe('deriveProjectPrefix', () => {
  it('returns the basename when no collision', () => {
    expect(deriveProjectPrefix('/home/me/projects/issue-flow', [])).toBe('issue-flow');
    expect(deriveProjectPrefix('/srv/widgets/', [])).toBe('widgets');
  });

  it('falls back to a default when the basename has no alphanumerics', () => {
    expect(deriveProjectPrefix('/repo/...', [])).toBe('project');
  });

  // P3 — two repositories with the same basename.
  it('P3: appends -2, -3, ... to avoid collisions', () => {
    expect(deriveProjectPrefix('/a/web', ['web'])).toBe('web-2');
    expect(deriveProjectPrefix('/a/web', ['web', 'web-2'])).toBe('web-3');
  });

  it('sanitizes weird basenames', () => {
    expect(deriveProjectPrefix('/projects/My Cool App!', [])).toBe('my-cool-app');
  });

  // P4 — a repository literally named after a hub route.
  it('P4: never returns a reserved prefix even when the basename matches one', () => {
    expect(deriveProjectPrefix('/srv/api', [])).toBe('api-2');
    expect(deriveProjectPrefix('/srv/ws', [])).toBe('ws-2');
    expect(deriveProjectPrefix('/srv/assets', [])).toBe('assets-2');
    // Widened beyond the upstream set: this server answers /api/health and
    // serves its assets from the root.
    expect(deriveProjectPrefix('/srv/health', [])).toBe('health-2');
  });

  it('keeps every hub route in the reserved set', () => {
    expect([...RESERVED_PROJECT_PREFIXES].sort()).toEqual([
      'api',
      'assets',
      'health',
      // Still reserved after §50.8 removed the panel that lived at `/legacy/`:
      // the route is gone, so the address answers 404, and a 404 is the honest
      // answer for a bookmark of a panel that no longer exists. Freeing the
      // word would let a project claim it and answer something else there.
      'legacy',
      'ws',
    ]);
  });

  it('splits on the Windows separator too', () => {
    expect(deriveProjectPrefix('C:\\code\\widgets', [])).toBe('widgets');
  });
});
