import { isAbsolute, normalize, sep } from 'node:path';
import { loadPolicyConfig, mergeConfigLayers } from '../config.js';
import type { PolicyConfig, PolicyConfigInput } from '../schemas.js';
import { printWarning } from '../ui/logger.js';
import { getProjectRoot } from '../utils/git.js';
import {
  discoverBaseBranch,
  discoverCodeowners,
  discoverDocuments,
  discoverGitConventions,
  discoverGitHubSlug,
  discoverIssueTemplates,
  discoverIssueTypes,
  discoverLabels,
  discoverOrganizationForms,
  discoverOrganizationTemplates,
  discoverPullRequestTemplates,
} from './discovery.js';
import {
  POLICY_SCHEMA_VERSION,
  type PolicyExec,
  type PolicyGit,
  type PolicyIssues,
  type PolicyPullRequests,
  type PolicySource,
  type RepositoryPolicy,
} from './types.js';

/**
 * Resolution of the repository policy: discovery, precedence, scope and cache.
 */

export interface LoadRepositoryPolicyOptions {
  /** Local-only discovery never probes GitHub. Included in the cache key. */
  remote?: boolean;
  /** Repository root. Defaults to the git project root. */
  root?: string;
  /** Subdirectory the policy applies to, for monorepos. Root when omitted. */
  scope?: string | null;
  /** CLI overrides of the `policy` key. */
  cli?: PolicyConfigInput;
  /** Environment source. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Warning sink. Defaults to printWarning. */
  warn?: (message: string) => void;
  /** External command seam, for tests. Defaults to `utils/shell.ts`'s `run`. */
  exec?: PolicyExec;
  /** Set to false to bypass the per-process cache. Defaults to true. */
  cache?: boolean;
}

/**
 * Normalize a scope into a repository-relative POSIX path, or null.
 *
 * An absolute path, a path escaping the root and `.` all mean "the root": a
 * scope is a hint about where in a monorepo the work is happening, never a way
 * to read outside the repository.
 */
export function normalizeScope(scope: string | null | undefined): string | null {
  if (scope === null || scope === undefined) return null;

  const trimmed = scope.trim();
  if (trimmed === '' || trimmed === '.' || isAbsolute(trimmed)) return null;

  const normalized = normalize(trimmed)
    .split(sep)
    .join('/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  if (normalized === '' || normalized === '.' || normalized.startsWith('..')) return null;

  return normalized;
}

/** An enabled policy with nothing in it — also the shape of a disabled one. */
function emptyPolicy(
  root: string,
  scope: string | null,
  enabled: boolean,
  sources: PolicySource[],
): RepositoryPolicy {
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    root,
    scope,
    enabled,
    issues: { templates: [], types: [], labels: [], titleConvention: null },
    pullRequests: { template: null, templates: [], baseBranch: null, titleConvention: null },
    git: {
      branchConvention: null,
      commitConvention: null,
      pullRequestTitleConvention: null,
      issueReference: null,
      typeMap: null,
      allowedTypes: null,
      scopes: null,
      commitTemplate: null,
      declared: false,
    },
    docs: [],
    codeowners: null,
    sources,
  };
}

/** Provenance entry for a discovery pass the configuration turned off. */
function disabledSource(kind: PolicySource['kind']): PolicySource {
  return {
    kind,
    origin: 'config',
    path: null,
    status: 'disabled',
    detail: 'disabled by configuration',
  };
}

/** Which `sources` entry a declared configuration key is accounted under. */
const DECLARATION_KINDS = {
  issues: 'issue-templates',
  pullRequests: 'pull-request-template',
  git: 'git-conventions',
} as const satisfies Record<string, PolicySource['kind']>;

/**
 * Resolve the policy of `root` for `scope`, uncached.
 *
 * The ladder, exactly as `mergeConfigLayers` applies it:
 *
 *   Issue Flow defaults < discovered repository policies
 *     < "policy" key of .issue-flow.json < ISSUE_FLOW_POLICY_* < CLI flags
 *
 * The three explicit layers are already collapsed by `loadPolicyConfig()`, so
 * what arrives here is "the defaults" and "what the user declared", with the
 * discovery in between. A declaration therefore corrects a wrong discovery
 * without having to disable it, and `discovery.*: false` turns a whole pass off
 * for the case where the discovery is not merely wrong but unwanted.
 */
async function resolvePolicy(
  root: string,
  scope: string | null,
  options: LoadRepositoryPolicyOptions,
): Promise<RepositoryPolicy> {
  const warn = options.warn ?? printWarning;
  const config: PolicyConfig = await loadPolicyConfig({
    projectRoot: root,
    env: options.env,
    cli: options.cli,
    warn,
  });

  if (!config.enabled) {
    // Not a single stat() or round-trip: "off" has to be free, otherwise it is
    // not really a way out of a discovery that is misbehaving.
    return emptyPolicy(root, scope, false, [
      { kind: 'docs', origin: 'config', path: null, status: 'disabled', detail: 'policy.enabled' },
    ]);
  }

  const toggles = config.discovery;

  const [templateDiscovery, prTemplates, documents, codeowners, gitConventions] = await Promise.all(
    [
      toggles.issueTemplates
        ? discoverIssueTemplates(root)
        : Promise.resolve({ templates: [], sources: [disabledSource('issue-templates')] }),
      toggles.pullRequestTemplate
        ? discoverPullRequestTemplates(root)
        : Promise.resolve({ templates: [], sources: [disabledSource('pull-request-template')] }),
      toggles.docs
        ? discoverDocuments(root, scope)
        : Promise.resolve({ documents: [], sources: [disabledSource('docs')] }),
      toggles.codeowners
        ? discoverCodeowners(root)
        : Promise.resolve({ content: null, sources: [disabledSource('codeowners')] }),
      discoverGitConventions(root, options.exec),
    ],
  );

  // The organization defaults are only worth asking for when the local tree has
  // none — that is precisely the case local discovery cannot see.
  const wantsOrgTemplates =
    options.remote !== false && toggles.issueTemplates && templateDiscovery.templates.length === 0;
  const [baseBranch, slug] = await Promise.all([
    options.remote === false
      ? Promise.resolve({ baseBranch: null, sources: [] })
      : discoverBaseBranch(root, options.exec),
    (options.remote !== false && toggles.issueTypes) || wantsOrgTemplates
      ? discoverGitHubSlug(root, options.exec)
      : Promise.resolve(null),
  ]);

  const [labels, issueTypes, orgTemplates, orgForms] = await Promise.all([
    options.remote !== false && toggles.labels
      ? discoverLabels(root, options.exec)
      : Promise.resolve({ labels: [], sources: [disabledSource('labels')] }),
    options.remote !== false && toggles.issueTypes
      ? discoverIssueTypes(root, slug?.owner ?? null, options.exec)
      : Promise.resolve({ types: [], sources: [disabledSource('issue-types')] }),
    wantsOrgTemplates
      ? discoverOrganizationTemplates(root, slug, options.exec)
      : Promise.resolve({ templates: [], sources: [] }),
    // Two calls, because GitHub answers the two kinds of organization default
    // through different surfaces: `issueTemplates` covers markdown templates and
    // is blind to Issue Forms, which only exist as files in the org's `.github`
    // repository. A repository whose organization publishes forms would
    // otherwise look like one with no templates at all.
    wantsOrgTemplates
      ? discoverOrganizationForms(root, slug?.owner ?? null, options.exec)
      : Promise.resolve({ templates: [], sources: [] }),
  ]);

  const sources: PolicySource[] = [
    ...templateDiscovery.sources,
    ...orgTemplates.sources,
    ...orgForms.sources,
    ...issueTypes.sources,
    ...labels.sources,
    ...prTemplates.sources,
    ...baseBranch.sources,
    ...documents.sources,
    ...codeowners.sources,
    ...gitConventions.sources,
  ];

  // Only the base branch is inferable today; the conventions have no reliable
  // signal in a repository and are therefore declared, never guessed.
  const discoveredPullRequests: Partial<PolicyPullRequests> = {};
  if (baseBranch.baseBranch !== null) {
    discoveredPullRequests.baseBranch = baseBranch.baseBranch;
  }

  const issues = mergeConfigLayers<PolicyIssues>({
    defaults: { titleConvention: null },
    project: config.issues,
  });
  const pullRequests = mergeConfigLayers<PolicyPullRequests>({
    defaults: { baseBranch: null, titleConvention: null },
    discovered: discoveredPullRequests,
    project: config.pullRequests,
  });
  const discoveredGit: Partial<PolicyGit> = {};
  if (gitConventions.commitConvention !== null) {
    discoveredGit.commitConvention = gitConventions.commitConvention;
  }
  if (gitConventions.pullRequestTitleConvention !== null) {
    discoveredGit.pullRequestTitleConvention = gitConventions.pullRequestTitleConvention;
  }
  if (gitConventions.allowedTypes !== null) {
    discoveredGit.allowedTypes = gitConventions.allowedTypes;
  }
  if (gitConventions.scopes !== null) {
    discoveredGit.scopes = gitConventions.scopes;
  }
  if (gitConventions.branchConvention !== null) {
    discoveredGit.branchConvention = gitConventions.branchConvention;
  }
  if (gitConventions.commitTemplate !== null) {
    discoveredGit.commitTemplate = gitConventions.commitTemplate;
  }

  const git = mergeConfigLayers<PolicyGit>({
    defaults: {
      branchConvention: null,
      commitConvention: null,
      pullRequestTitleConvention: null,
      issueReference: null,
      typeMap: null,
      allowedTypes: null,
      scopes: null,
      commitTemplate: null,
      declared: false,
    },
    discovered: discoveredGit,
    project: config.git,
  });

  for (const group of ['issues', 'pullRequests', 'git'] as const) {
    for (const key of Object.keys(config[group])) {
      sources.push({
        kind: DECLARATION_KINDS[group],
        origin: 'config',
        path: null,
        status: 'found',
        detail: `${group}.${key} declared`,
      });
    }
  }

  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    root,
    scope,
    enabled: true,
    issues: {
      templates: [...templateDiscovery.templates, ...orgTemplates.templates, ...orgForms.templates],
      types: issueTypes.types,
      labels: labels.labels,
      titleConvention: issues.titleConvention ?? null,
    },
    pullRequests: {
      template: prTemplates.templates[0]?.content ?? null,
      templates: prTemplates.templates,
      baseBranch: pullRequests.baseBranch ?? null,
      titleConvention: pullRequests.titleConvention ?? null,
    },
    git: {
      branchConvention: git.branchConvention ?? null,
      commitConvention: git.commitConvention ?? null,
      pullRequestTitleConvention: git.pullRequestTitleConvention ?? null,
      issueReference: git.issueReference ?? null,
      typeMap: git.typeMap ?? null,
      allowedTypes: git.allowedTypes ?? gitConventions.allowedTypes,
      scopes: git.scopes ?? gitConventions.scopes,
      commitTemplate: git.commitTemplate ?? gitConventions.commitTemplate,
      // A key written in `.issue-flow.json` is the most explicit declaration
      // there is, so it counts alongside the files the repository ships.
      declared: gitConventions.declared || Object.keys(config.git).length > 0,
    },
    docs: documents.documents,
    codeowners: codeowners.content,
    sources,
  };
}

/**
 * Per-process cache, keyed by `(root, scope)`.
 *
 * Discovery walks the filesystem and may talk to `gh`; a pipeline that resolved
 * it once per phase would pay that several times over for an answer that cannot
 * change mid-run. The promise — not its result — is cached, so two concurrent
 * callers share a single discovery instead of racing two.
 */
const cache = new Map<string, Promise<RepositoryPolicy>>();

/** Drop every cached resolution. Exported for tests and long-lived processes. */
export function resetPolicyCache(): void {
  cache.clear();
}

/**
 * The repository policy applying to `scope`, resolved once per process.
 *
 * Never throws for a repository that declares nothing: the result is an empty
 * policy, with no warning, and every consumer keeps its own defaults. The only
 * error it can raise is the one `getProjectRoot()` already raises when there is
 * no repository at all — and passing `root` avoids even that.
 */
export async function loadRepositoryPolicy(
  options: LoadRepositoryPolicyOptions = {},
): Promise<RepositoryPolicy> {
  const root = options.root ?? (await getProjectRoot());
  const scope = normalizeScope(options.scope);

  if (options.cache === false) {
    return resolvePolicy(root, scope, options);
  }

  const key = `${root}\0${scope ?? ''}\0${options.remote !== false}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const pending = resolvePolicy(root, scope, options);
  cache.set(key, pending);
  try {
    return await pending;
  } catch (err) {
    // A rejected promise must not be served to every later caller.
    cache.delete(key);
    throw err;
  }
}
