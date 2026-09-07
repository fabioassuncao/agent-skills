import { describe, expect, it } from 'vitest';
import { matchProjectResource, resolveProjectRoute } from './router.js';

const served =
  (...prefixes: string[]) =>
  (prefix: string) =>
    prefixes.includes(prefix);

describe('resolveProjectRoute', () => {
  it('strips a served project prefix and reports it', () => {
    expect(resolveProjectRoute('/web/api/sessions', served('web'))).toEqual({
      prefix: 'web',
      path: '/api/sessions',
    });
  });

  // P3 — the disambiguated prefix routes exactly like the first one.
  it('P3: routes a disambiguated prefix', () => {
    expect(resolveProjectRoute('/web-2/api/sessions', served('web', 'web-2'))).toEqual({
      prefix: 'web-2',
      path: '/api/sessions',
    });
  });

  it('leaves hub routes untouched', () => {
    expect(resolveProjectRoute('/api/sessions', served('web'))).toEqual({
      prefix: null,
      path: '/api/sessions',
    });
    expect(resolveProjectRoute('/', served('web'))).toEqual({ prefix: null, path: '/' });
    expect(resolveProjectRoute('/app.js', served('web'))).toEqual({
      prefix: null,
      path: '/app.js',
    });
  });

  // P4 — a reserved segment can never be captured as a project.
  it('P4: never treats a reserved segment as a project prefix', () => {
    for (const reserved of ['api', 'ws', 'assets', 'health']) {
      expect(resolveProjectRoute(`/${reserved}/api/sessions`, served(reserved))).toEqual({
        prefix: null,
        path: `/${reserved}/api/sessions`,
      });
    }
  });

  it('falls through to the hub route table for an unknown prefix', () => {
    // A typo must answer the hub's own 404, not "project not found" for a path
    // that was never a project path.
    expect(resolveProjectRoute('/typo/api/sessions', served('web'))).toEqual({
      prefix: null,
      path: '/typo/api/sessions',
    });
  });

  it('needs a path after the prefix to resolve one', () => {
    expect(resolveProjectRoute('/web', served('web'))).toEqual({ prefix: null, path: '/web' });
  });
});

describe('matchProjectResource', () => {
  it('extracts the prefix of a project resource', () => {
    expect(matchProjectResource('/api/projects/web')).toBe('web');
    expect(matchProjectResource('/api/projects/web%2D2')).toBe('web-2');
  });

  it('does not match the collection or anything deeper', () => {
    expect(matchProjectResource('/api/projects')).toBeNull();
    expect(matchProjectResource('/api/projects/web/sessions')).toBeNull();
    expect(matchProjectResource('/api/sessions')).toBeNull();
  });
});
