import type { ChangeType } from '../../conventions/git/index.js';
import { isChangeType } from '../../conventions/git/index.js';

/**
 * Textual readers for Git conventions declared by the repository.
 *
 * `.js` / `.ts` / `.mjs` / `.cjs` are scanned as text. They are never
 * `import()`ed — that would execute arbitrary code from the target repository.
 */

export interface DiscoveredGitConventions {
  commitConvention: string | null;
  pullRequestTitleConvention: string | null;
  allowedTypes: string[] | null;
  scopes: string[] | null;
  sources: { path: string; detail: string }[];
}

const COMMITLINT_NAMES = [
  '.commitlintrc',
  '.commitlintrc.json',
  '.commitlintrc.yaml',
  '.commitlintrc.yml',
  '.commitlintrc.js',
  '.commitlintrc.cjs',
  '.commitlintrc.mjs',
  '.commitlintrc.ts',
  'commitlint.config.js',
  'commitlint.config.cjs',
  'commitlint.config.mjs',
  'commitlint.config.ts',
];

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function extractQuotedStrings(block: string): string[] {
  const matches = block.match(/['"]([a-z][a-z0-9-]*)['"]/g) ?? [];
  return matches.map((token) => token.slice(1, -1));
}

function extractEnum(source: string, rule: 'type-enum' | 'scope-enum'): string[] {
  const escaped = rule.replace('-', '\\-');
  const match = source.match(new RegExp(`${escaped}[\\s\\S]{0,800}?\\[([\\s\\S]*?)\\]`, 'i'));
  if (match?.[1] === undefined) return [];
  return extractQuotedStrings(match[1]).filter((value) => value !== 'always' && value !== 'never');
}

function parseCommitlintSource(source: string, path: string): DiscoveredGitConventions {
  const types = extractEnum(source, 'type-enum').filter(isChangeType);
  const scopes = extractEnum(source, 'scope-enum');
  const conventional = /conventional|commitlint/i.test(source) || types.length > 0;
  return {
    commitConvention: conventional ? 'conventional' : null,
    pullRequestTitleConvention: null,
    allowedTypes: types.length > 0 ? unique(types) : null,
    scopes: scopes.length > 0 ? unique(scopes) : null,
    sources: [{ path, detail: conventional ? 'commitlint' : 'commitlint (unrecognised)' }],
  };
}

function parsePackageCommitlint(pkg: unknown): DiscoveredGitConventions | null {
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return null;
  const commitlint = (pkg as { commitlint?: unknown }).commitlint;
  if (commitlint === undefined || commitlint === null) return null;
  const source = JSON.stringify(commitlint);
  return parseCommitlintSource(source, 'package.json#commitlint');
}

function parseSemanticPrWorkflow(source: string, path: string): DiscoveredGitConventions | null {
  if (!/amannn\/action-semantic-pull-request/.test(source)) return null;
  const typesBlock = source.match(/types:\s*[|>]?\s*\n((?:\s{2,}[a-z][a-z0-9-]*\s*\n)+)/i);
  const scopesBlock = source.match(/scopes:\s*[|>]?\s*\n((?:\s{2,}[a-z][a-z0-9-]*\s*\n)+)/i);
  const types =
    typesBlock?.[1]
      ?.split('\n')
      .map((line) => line.trim())
      .filter((line) => isChangeType(line)) ?? [];
  const scopes =
    scopesBlock?.[1]
      ?.split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[a-z][a-z0-9-]*$/.test(line)) ?? [];
  return {
    commitConvention: 'conventional',
    pullRequestTitleConvention: 'conventional',
    allowedTypes: types.length > 0 ? unique(types) : null,
    scopes: scopes.length > 0 ? unique(scopes) : null,
    sources: [{ path, detail: 'amannn/action-semantic-pull-request' }],
  };
}

export function parseCommitlintText(source: string, path: string): DiscoveredGitConventions {
  return parseCommitlintSource(source, path);
}

export function parsePackageJsonCommitlint(raw: string): DiscoveredGitConventions | null {
  try {
    return parsePackageCommitlint(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function parseReleasePlease(_raw: string, path: string): DiscoveredGitConventions {
  return {
    commitConvention: 'conventional',
    pullRequestTitleConvention: null,
    allowedTypes: null,
    scopes: null,
    sources: [{ path, detail: 'release-please (Conventional Commits)' }],
  };
}

export function parseSemanticRelease(path: string): DiscoveredGitConventions {
  return {
    commitConvention: 'conventional',
    pullRequestTitleConvention: null,
    allowedTypes: null,
    scopes: null,
    sources: [{ path, detail: 'semantic-release' }],
  };
}

export function parseChangesetConfig(path: string): DiscoveredGitConventions {
  return {
    commitConvention: null,
    pullRequestTitleConvention: null,
    allowedTypes: null,
    scopes: null,
    sources: [{ path, detail: 'changesets release flow' }],
  };
}

export function parseHuskyCommitMsg(path: string): DiscoveredGitConventions {
  return {
    commitConvention: null,
    pullRequestTitleConvention: null,
    allowedTypes: null,
    scopes: null,
    sources: [{ path, detail: 'husky commit-msg hook' }],
  };
}

export function parseSemanticPullRequestWorkflow(
  source: string,
  path: string,
): DiscoveredGitConventions | null {
  return parseSemanticPrWorkflow(source, path);
}

export const COMMITLINT_FILE_NAMES = COMMITLINT_NAMES;

export type { ChangeType };
