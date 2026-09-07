import { describe, expect, it } from 'vitest';
import {
  parseBranchHistory,
  parseCommitHistory,
  parseCommitlintText,
  parseCommitTemplate,
  parsePackageJsonCommitlint,
  parseReleasePlease,
  parseSemanticPullRequestWorkflow,
} from './git.js';

describe('git convention parsers', () => {
  it('reads type-enum from commitlint text without executing it', () => {
    const source = `
      module.exports = {
        rules: {
          'type-enum': [2, 'always', ['feat', 'fix', 'docs']],
          'scope-enum': [2, 'always', ['core', 'web']],
        },
      };
    `;
    const parsed = parseCommitlintText(source, 'commitlint.config.js');
    expect(parsed.commitConvention).toBe('conventional');
    expect(parsed.allowedTypes).toEqual(['feat', 'fix', 'docs']);
    expect(parsed.scopes).toEqual(['core', 'web']);
  });

  it('reads package.json#commitlint', () => {
    const parsed = parsePackageJsonCommitlint(
      JSON.stringify({ commitlint: { extends: ['@commitlint/config-conventional'] } }),
    );
    expect(parsed?.commitConvention).toBe('conventional');
    expect(parsed?.sources[0]?.path).toBe('package.json#commitlint');
  });

  it('treats release-please as Conventional Commits', () => {
    expect(parseReleasePlease('{}', 'release-please-config.json').commitConvention).toBe(
      'conventional',
    );
  });

  it('reads types from action-semantic-pull-request', () => {
    const source = `
name: lint-pr
jobs:
  main:
    steps:
      - uses: amannn/action-semantic-pull-request@v5
        with:
          types: |
            feat
            fix
          scopes: |
            agents
            web
    `;
    const parsed = parseSemanticPullRequestWorkflow(source, '.github/workflows/lint-pr.yml');
    expect(parsed?.pullRequestTitleConvention).toBe('conventional');
    expect(parsed?.allowedTypes).toEqual(['feat', 'fix']);
    expect(parsed?.scopes).toEqual(['agents', 'web']);
  });
});

describe('the five sources added in the Git-convention phase', () => {
  it('reads a commit template as a declared format', () => {
    const parsed = parseCommitTemplate('# Summary\n#\n# Why:\n', '.gitmessage');
    expect(parsed.commitTemplate).toContain('# Why:');
    expect(parsed.commitConvention).toBe('template');
    expect(parsed.sources[0]).toMatchObject({ path: '.gitmessage', confidence: 'declared' });
  });

  it('recognises a template that names Conventional Commits', () => {
    expect(
      parseCommitTemplate('# <type>(<scope>): <subject>  (Conventional Commits)\n', '.gitmessage')
        .commitConvention,
    ).toBe('conventional');
  });

  it('reads commitlint run in CI, where the config often lives in a preset', () => {
    const action = parseSemanticPullRequestWorkflow(
      'jobs:\n  lint:\n    steps:\n      - uses: wagoid/commitlint-github-action@v6\n',
      '.github/workflows/ci.yml',
    );
    expect(action?.commitConvention).toBe('conventional');
    expect(action?.sources[0]?.confidence).toBe('declared');

    const step = parseSemanticPullRequestWorkflow(
      'jobs:\n  lint:\n    steps:\n      - run: npx commitlint --from origin/main\n',
      '.github/workflows/ci.yml',
    );
    expect(step?.sources[0]?.detail).toBe('commitlint in CI');
  });

  it('infers Conventional Commits from history, and marks it inferred', () => {
    const parsed = parseCommitHistory(
      [
        'feat(core): add failover probe',
        'fix: recover the created PR',
        'docs: describe the ladder',
        'chore(deps): bump vitest',
      ],
      'git log',
    );
    expect(parsed?.commitConvention).toBe('conventional');
    expect(parsed?.sources[0]?.confidence).toBe('inferred');
    // Never a vocabulary: what a repository used lately is not what it allows.
    expect(parsed?.allowedTypes).toBeNull();
  });

  it('infers nothing from a history that is not conventional, or too short', () => {
    expect(parseCommitHistory(['wip', 'more work', 'fix stuff', 'another'], 'git log')).toBeNull();
    expect(parseCommitHistory(['feat: a', 'fix: b'], 'git log')).toBeNull();
    // Merge commits are noise, not evidence of a convention either way.
    expect(
      parseCommitHistory(['Merge pull request #1', 'Merge branch main', 'Merge x'], 'git log'),
    ).toBeNull();
  });

  it('infers the branch pattern from the refs that exist', () => {
    expect(
      parseBranchHistory(
        ['feat/63-resilient-execution', 'fix/72-headless-timeout', 'chore/41-bump'],
        'refs',
      )?.branchConvention,
    ).toBe('{type}/{N}-{slug}');

    expect(
      parseBranchHistory(['fix-login-flow', 'add-search', 'refresh-sessions'], 'refs')
        ?.branchConvention,
    ).toBe('{slug}');

    expect(parseBranchHistory(['main', 'develop'], 'refs')).toBeNull();
  });
});
