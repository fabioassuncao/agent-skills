/**
 * The repository policy layer.
 *
 * `loadRepositoryPolicy()` is the single entry point: it discovers what the
 * consumer repository declares about itself (Issue Templates and Forms, labels,
 * Issue Types, the Pull Request template, `AGENTS.md`/`CLAUDE.md`,
 * `CONTRIBUTING.md`, `CODEOWNERS`), resolves the hierarchy applying to a scope,
 * and merges it with the explicit `policy` key of `.issue-flow.json`.
 *
 * It degrades silently by construction: a repository with none of those sources
 * resolves to an empty policy, without an error and without a warning, which is
 * exactly the behaviour every flow had before this layer existed.
 */

export {
  DISCOVERY_TIMEOUT_MS,
  discoverBaseBranch,
  discoverCodeowners,
  discoverDocuments,
  discoverGitHubSlug,
  discoverIssueTemplates,
  discoverIssueTypes,
  discoverLabels,
  discoverOrganizationForms,
  discoverOrganizationTemplates,
  discoverPullRequestTemplates,
  scopeLadder,
} from './discovery.js';
export {
  type LoadRepositoryPolicyOptions,
  loadRepositoryPolicy,
  normalizeScope,
  resetPolicyCache,
} from './resolve.js';
export {
  type IssueTemplate,
  type LabelDefinition,
  MAX_POLICY_DOCUMENT_BYTES,
  POLICY_SCHEMA_VERSION,
  type PolicyDocument,
  type PolicyDocumentKind,
  type PolicyExec,
  type PolicyGit,
  type PolicyIssues,
  type PolicyPullRequests,
  type PolicySource,
  type PolicySourceKind,
  type PolicySourceOrigin,
  type PolicySourceStatus,
  type PullRequestTemplate,
  type RepositoryPolicy,
} from './types.js';
