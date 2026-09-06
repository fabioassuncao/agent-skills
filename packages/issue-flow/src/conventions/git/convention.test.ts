import { describe, expect, it } from 'vitest';
import { DEFAULT_GIT_CONVENTION, resolveGitConvention } from './convention.js';
import { CHANGE_TYPES, isAllowedType } from './types.js';

describe('resolveGitConvention', () => {
  it('is the Issue Flow default when the repository declares nothing', () => {
    expect(resolveGitConvention()).toEqual(DEFAULT_GIT_CONVENTION);
  });

  it('yields the vocabulary only to a declaration, never to an inference', () => {
    // Discovered from history: informs, changes nothing.
    expect(
      resolveGitConvention({ commitConvention: 'conventional', allowedTypes: ['feat', 'fix'] })
        .commit.types,
    ).toEqual(CHANGE_TYPES);

    // Declared by a file the repository ships: the fallback steps aside.
    expect(
      resolveGitConvention({
        declared: true,
        commitConvention: 'conventional',
        allowedTypes: ['feat', 'fix'],
      }).commit.types,
    ).toEqual(['feat', 'fix']);
  });

  it('accepts any type when the declaration enumerates none', () => {
    const convention = resolveGitConvention({ declared: true, commitConvention: 'conventional' });
    expect(convention.commit.types).toBe('any');
    expect(isAllowedType('deps', convention.commit.types)).toBe(true);
    expect(isAllowedType('', convention.commit.types)).toBe(false);
  });

  it('reads a commit template as a declared format Issue Flow must not rewrite', () => {
    const convention = resolveGitConvention({
      declared: true,
      commitTemplate: '# Summary\n# Why\n',
      commitConvention: 'template',
    });
    expect(convention.commit.format).toBe('free');
    expect(convention.commit.template).toBe('# Summary\n# Why\n');
  });

  it('keeps rendering Conventional Commits when the declaration names them', () => {
    expect(
      resolveGitConvention({ declared: true, commitConvention: 'conventional' }).commit.format,
    ).toBe('conventional');
    expect(
      resolveGitConvention({
        declared: true,
        commitConvention: 'Conventional Commits — type(scope): subject',
      }).commit.format,
    ).toBe('conventional');
  });

  it('takes the branch pattern the repository declares', () => {
    expect(resolveGitConvention({ branchConvention: '{slug}' }).branch.pattern).toBe('{slug}');
    expect(resolveGitConvention({ branchConvention: '  ' }).branch.pattern).toBe(
      DEFAULT_GIT_CONVENTION.branch.pattern,
    );
  });

  it('never yields closesWhenVerified, which is a guarantee rather than a preference', () => {
    const convention = resolveGitConvention({
      declared: true,
      commitConvention: 'free',
      pullRequestTitleConvention: 'free',
    });
    expect(convention.pullRequest.closesWhenVerified).toBe(true);
    expect(convention.commit.footer.refs).toBe(true);
  });

  it('turns signoff on only when it is declared', () => {
    expect(resolveGitConvention({}).commit.footer.signoff).toBe(false);
    expect(resolveGitConvention({ signoff: true }).commit.footer.signoff).toBe(true);
  });
});
