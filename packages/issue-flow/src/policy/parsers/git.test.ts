import { describe, expect, it } from 'vitest';
import {
  parseCommitlintText,
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
