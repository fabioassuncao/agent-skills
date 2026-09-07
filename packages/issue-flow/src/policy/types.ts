/**
 * The repository policy layer: what the *consumer* repository already declares
 * about how issues, Pull Requests, branches and agents are supposed to work.
 *
 * Every field is discovered, never invented. A repository that declares nothing
 * produces an empty policy — which is exactly the behaviour Issue Flow had
 * before this layer existed.
 */

/**
 * Version of the {@link RepositoryPolicy} shape. Bumped whenever a consumer
 * reading `issue-flow policy --json` would have to change to keep working;
 * purely additive fields do not bump it.
 */
export const POLICY_SCHEMA_VERSION = 1;

/** What a {@link PolicySource} is accounting for. */
export type PolicySourceKind =
  | 'issue-templates'
  | 'issue-types'
  | 'labels'
  | 'pull-request-template'
  | 'base-branch'
  | 'docs'
  | 'codeowners'
  | 'git-conventions';

/** Where a {@link PolicySource} came from. */
export type PolicySourceOrigin = 'filesystem' | 'gh' | 'git' | 'config' | 'env' | 'cli';

/**
 * Outcome of consulting a source.
 *
 * `found` and `disabled` are ordinary states. `unavailable` is the one that
 * matters for debugging: the source *could* have answered but did not — no
 * `gh`, no network, a timeout — and the policy is therefore incomplete rather
 * than empty. Nothing absent is recorded: a repository without a
 * `CONTRIBUTING.md` would otherwise drown `sources` in negative entries.
 *
 * Git conventions refine `found` into two, and the difference is what makes it
 * safe to stop imposing a default: `declared` is a rule the repository wrote
 * down (a commitlint config, a `.gitmessage`, a husky hook) and it turns the
 * Issue Flow fallback off; `inferred` is a pattern read out of history and it
 * only informs. Guessing from a handful of commits is not a mandate.
 */
export type PolicySourceStatus = 'found' | 'declared' | 'inferred' | 'unavailable' | 'disabled';

/**
 * Provenance of one piece of the resolved policy.
 *
 * Not an accessory: without it there is no way to explain why a decision was
 * taken, nor to debug a wrong discovery.
 */
export interface PolicySource {
  kind: PolicySourceKind;
  origin: PolicySourceOrigin;
  /** Repository-relative path (POSIX separators), or null for non-file sources. */
  path: string | null;
  status: PolicySourceStatus;
  /** Human-readable note: the gh command that failed, the reason, a count. */
  detail: string | null;
}

/** An Issue Template or Issue Form declared by the repository. */
export interface IssueTemplate {
  /** Repository-relative path, or the org-level template name when remote. */
  path: string;
  /** `form` for a GitHub Issue Form (`.yml`), `markdown` for a legacy template. */
  format: 'form' | 'markdown';
  /** Where the template was found — the local tree or the organization defaults. */
  origin: 'filesystem' | 'organization';
  name: string | null;
  about: string | null;
  /** Pre-filled title, which is also the closest thing to a title convention. */
  title: string | null;
  labels: string[];
  /** GitHub Issue Type declared by the template (`type:` key), when present. */
  type: string | null;
  assignees: string[];
  /** Raw file content, truncated at {@link MAX_POLICY_DOCUMENT_BYTES}. */
  content: string;
}

/** A label that really exists in the repository. */
export interface LabelDefinition {
  name: string;
  description: string | null;
  color: string | null;
}

/** A Pull Request template file. */
export interface PullRequestTemplate {
  path: string;
  name: string;
  content: string;
}

/** What a {@link PolicyDocument} is. */
export type PolicyDocumentKind =
  | 'agents'
  | 'claude'
  | 'contributing'
  | 'code-of-conduct'
  | 'referenced';

/** A prose document that carries repository policy. */
export interface PolicyDocument {
  path: string;
  kind: PolicyDocumentKind;
  /**
   * Directory the document governs, repository-relative; `''` is the root.
   * Documents are ordered from the root down to the requested scope, so the
   * later entry is the more specific one.
   */
  scope: string;
  /** Repository-relative path of the document that linked to this one. */
  referencedFrom: string | null;
  /** File content, truncated at {@link MAX_POLICY_DOCUMENT_BYTES}. */
  content: string;
}

/** Conventions of the repository around issues. */
export interface PolicyIssues {
  templates: IssueTemplate[];
  /** Issue Types of the organization, when the plan exposes them. */
  types: string[];
  /** Labels that really exist in the repository, never a guessed taxonomy. */
  labels: LabelDefinition[];
  titleConvention: string | null;
}

/** Conventions of the repository around Pull Requests. */
export interface PolicyPullRequests {
  /** Content of the default Pull Request template, or null. */
  template: string | null;
  /** Every template found, for the multi-template directory layout. */
  templates: PullRequestTemplate[];
  baseBranch: string | null;
  titleConvention: string | null;
}

/** Conventions of the repository around git itself. */
export interface PolicyGit {
  branchConvention: string | null;
  commitConvention: string | null;
  pullRequestTitleConvention: string | null;
  issueReference: string | null;
  typeMap: Record<string, string> | null;
  allowedTypes: string[] | null;
  scopes: string[] | null;
  /**
   * Content of the repository's `commit.template` — a `.gitmessage` at the root
   * or whatever `git config commit.template` points at. It is a commit format
   * the repository wrote down, so it is a declaration, not a hint.
   */
  commitTemplate: string | null;
  /**
   * True when at least one Git convention above came from a source the
   * repository *declares*, as opposed to one inferred from history. Only a
   * declaration turns the Issue Flow fallback off (§11).
   */
  declared: boolean;
}

export const EMPTY_POLICY_GIT: PolicyGit = {
  branchConvention: null,
  commitConvention: null,
  pullRequestTitleConvention: null,
  issueReference: null,
  typeMap: null,
  allowedTypes: null,
  scopes: null,
  commitTemplate: null,
  declared: false,
};

/** The resolved policy of a repository, at a given scope. */
export interface RepositoryPolicy {
  schemaVersion: typeof POLICY_SCHEMA_VERSION;
  /** Absolute path of the repository root the policy was resolved against. */
  root: string;
  /** Repository-relative subdirectory the policy was resolved for, or null. */
  scope: string | null;
  /** False when `policy.enabled` is off — every section is then empty. */
  enabled: boolean;
  issues: PolicyIssues;
  pullRequests: PolicyPullRequests;
  git: PolicyGit;
  docs: PolicyDocument[];
  /** Content of the CODEOWNERS file, or null. */
  codeowners: string | null;
  sources: PolicySource[];
}

/** Result of an external command, mirroring `utils/shell.ts`'s ExecResult. */
export interface PolicyExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Seam for every external command the discovery shells out to (`gh`, `git`).
 * Injectable so the suite can exercise both the answer and the absence without
 * a real binary.
 */
export type PolicyExec = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<PolicyExecResult>;

/**
 * Upper bound on the bytes read from any single policy document or template.
 *
 * Discovery feeds an agent's context window: an unbounded `AGENTS.md` would
 * cost more than it explains. Truncation is recorded in `sources`.
 */
export const MAX_POLICY_DOCUMENT_BYTES = 64 * 1024;
