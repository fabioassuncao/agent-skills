import type { ChangeType } from '../../conventions/git/index.js';
import { isChangeType } from '../../conventions/git/index.js';

/**
 * Textual readers for Git conventions declared by the repository.
 *
 * `.js` / `.ts` / `.mjs` / `.cjs` are scanned as text. They are never
 * `import()`ed — that would execute arbitrary code from the target repository.
 */

/**
 * Whether a source is a rule the repository wrote down or a pattern read out of
 * its history. Only `declared` turns the Issue Flow fallback off (§11).
 */
export type GitConventionConfidence = 'declared' | 'inferred';

export interface DiscoveredGitConventions {
  commitConvention: string | null;
  pullRequestTitleConvention: string | null;
  branchConvention: string | null;
  commitTemplate: string | null;
  allowedTypes: string[] | null;
  scopes: string[] | null;
  sources: { path: string; detail: string; confidence: GitConventionConfidence }[];
}

/** An empty result, so every parser can spread over one shape. */
const NOTHING: Omit<DiscoveredGitConventions, 'sources'> = {
  commitConvention: null,
  pullRequestTitleConvention: null,
  branchConvention: null,
  commitTemplate: null,
  allowedTypes: null,
  scopes: null,
};

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
    ...NOTHING,
    commitConvention: conventional ? 'conventional' : null,
    allowedTypes: types.length > 0 ? unique(types) : null,
    scopes: scopes.length > 0 ? unique(scopes) : null,
    sources: [
      {
        path,
        detail: conventional ? 'commitlint' : 'commitlint (unrecognised)',
        confidence: 'declared',
      },
    ],
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
    ...NOTHING,
    commitConvention: 'conventional',
    pullRequestTitleConvention: 'conventional',
    allowedTypes: types.length > 0 ? unique(types) : null,
    scopes: scopes.length > 0 ? unique(scopes) : null,
    sources: [{ path, detail: 'amannn/action-semantic-pull-request', confidence: 'declared' }],
  };
}

/**
 * A workflow that runs `commitlint` in CI.
 *
 * A repository that gates every push on `commitlint` has declared its commit
 * format as firmly as one that ships the config file, and plenty of them keep
 * the config in a shared preset rather than in the tree.
 */
function parseCommitlintWorkflow(source: string, path: string): DiscoveredGitConventions | null {
  const action = /wagoid\/commitlint-github-action/.test(source);
  const step = /(?:npx|pnpm|yarn|bunx)[^\n]*\bcommitlint\b/.test(source);
  if (!action && !step) return null;
  return {
    ...NOTHING,
    commitConvention: 'conventional',
    sources: [
      {
        path,
        detail: action ? 'wagoid/commitlint-github-action' : 'commitlint in CI',
        confidence: 'declared',
      },
    ],
  };
}

/**
 * The repository's `commit.template` — `.gitmessage`, usually.
 *
 * Git itself pre-fills every `git commit` with this file, so it *is* the
 * repository's commit format. Issue Flow rendering its own on top would be the
 * fallback overruling a declaration.
 */
export function parseCommitTemplate(content: string, path: string): DiscoveredGitConventions {
  return {
    ...NOTHING,
    commitTemplate: content,
    // Only a template that spells out Conventional Commits declares that format;
    // any other template declares a format Issue Flow must not rewrite.
    commitConvention: /conventional/i.test(content) ? 'conventional' : 'template',
    sources: [{ path, detail: 'git commit.template', confidence: 'declared' }],
  };
}

const CONVENTIONAL_SUBJECT = /^[a-z][a-z0-9-]*(\([^)]*\))?!?: .+/;

/**
 * Infer the commit format from recent history.
 *
 * Last resort, and deliberately `inferred`: it reports what the repository does
 * without claiming the repository decided it. A run of merge commits, a
 * squashed import or a repository younger than the threshold must not be able
 * to switch off a default.
 */
export function parseCommitHistory(
  subjects: string[],
  path: string,
): DiscoveredGitConventions | null {
  const candidates = subjects
    .map((subject) => subject.trim())
    .filter((subject) => subject !== '' && !subject.startsWith('Merge '));
  if (candidates.length < 3) return null;

  const conventional = candidates.filter((subject) => CONVENTIONAL_SUBJECT.test(subject));
  if (conventional.length / candidates.length < 0.6) return null;

  const types = unique(
    conventional
      .map((subject) => subject.slice(0, subject.search(/[(!:]/)))
      .filter((type) => isChangeType(type)),
  );

  return {
    ...NOTHING,
    commitConvention: 'conventional',
    // Never `allowedTypes`: an inferred list is what the repository happened to
    // use lately, and pinning it would reject a legitimate type on the next commit.
    sources: [
      {
        path,
        detail: `${conventional.length}/${candidates.length} recent commits, types ${types.join(', ') || 'none recognised'}`,
        confidence: 'inferred',
      },
    ],
  };
}

const TYPED_BRANCH = /^[a-z][a-z0-9-]*\/\d+-/;
const TYPED_BRANCH_NO_NUMBER = /^[a-z][a-z0-9-]*\/[a-z0-9]/;

/**
 * Infer the branch pattern from the refs that already exist.
 *
 * Also `inferred`, and for the same reason: it explains what a reviewer will
 * see in `git branch --list`, and nothing more.
 */
export function parseBranchHistory(names: string[], path: string): DiscoveredGitConventions | null {
  const candidates = names.map((name) => name.trim()).filter((name) => name !== '');
  if (candidates.length < 3) return null;

  const numbered = candidates.filter((name) => TYPED_BRANCH.test(name)).length;
  const prefixed = candidates.filter((name) => TYPED_BRANCH_NO_NUMBER.test(name)).length;
  const flat = candidates.length - prefixed;

  if (numbered / candidates.length >= 0.6) {
    return {
      ...NOTHING,
      branchConvention: '{type}/{N}-{slug}',
      sources: [
        {
          path,
          detail: `${numbered}/${candidates.length} branches use {type}/{N}-{slug}`,
          confidence: 'inferred',
        },
      ],
    };
  }
  if (flat / candidates.length >= 0.6) {
    return {
      ...NOTHING,
      branchConvention: '{slug}',
      sources: [
        {
          path,
          detail: `${flat}/${candidates.length} branches carry no type prefix`,
          confidence: 'inferred',
        },
      ],
    };
  }
  return null;
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
    ...NOTHING,
    commitConvention: 'conventional',
    sources: [{ path, detail: 'release-please (Conventional Commits)', confidence: 'declared' }],
  };
}

export function parseSemanticRelease(path: string): DiscoveredGitConventions {
  return {
    ...NOTHING,
    commitConvention: 'conventional',
    sources: [{ path, detail: 'semantic-release', confidence: 'declared' }],
  };
}

export function parseChangesetConfig(path: string): DiscoveredGitConventions {
  return {
    ...NOTHING,
    sources: [{ path, detail: 'changesets release flow', confidence: 'declared' }],
  };
}

export function parseHuskyCommitMsg(path: string): DiscoveredGitConventions {
  return {
    ...NOTHING,
    sources: [{ path, detail: 'husky commit-msg hook', confidence: 'declared' }],
  };
}

export function parseSemanticPullRequestWorkflow(
  source: string,
  path: string,
): DiscoveredGitConventions | null {
  return parseSemanticPrWorkflow(source, path) ?? parseCommitlintWorkflow(source, path);
}

export const COMMITLINT_FILE_NAMES = COMMITLINT_NAMES;

export type { ChangeType };
