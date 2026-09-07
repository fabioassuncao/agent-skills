import { describe, expect, it } from 'vitest';
import { repoSlugForEntry, repoTargets } from './linked-repos.js';

describe('repoTargets', () => {
  it('puts the current repository first, then each linked one', () => {
    expect(
      repoTargets([
        { repo: 'acme/api', alias: 'api' },
        { repo: 'acme/web', alias: 'web' },
      ]),
    ).toEqual([{}, { slug: 'acme/api', label: 'api' }, { slug: 'acme/web', label: 'web' }]);
  });

  it('yields only the current repository when none is linked', () => {
    expect(repoTargets([])).toEqual([{}]);
  });
});

describe('repoSlugForEntry', () => {
  const linked = [{ repo: 'acme/api', alias: 'api' }];

  it('resolves the slug behind an alias', () => {
    expect(repoSlugForEntry({ repo: 'api' }, linked)).toBe('acme/api');
  });

  it('reports the current repository as no slug', () => {
    expect(repoSlugForEntry({ repo: '' }, linked)).toBeUndefined();
  });

  it('reports an unknown alias as no slug rather than guessing one', () => {
    expect(repoSlugForEntry({ repo: 'gone' }, linked)).toBeUndefined();
  });
});
