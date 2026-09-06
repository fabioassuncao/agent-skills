/**
 * Canonical Git convention types. No function in this directory accepts a
 * provider, agent or model — that leakage is unrepresentable here.
 */

/** Conventional-commit vocabulary shared by branch, commit and PR title. */
export const CHANGE_TYPES = [
  'feat',
  'fix',
  'docs',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'style',
  'revert',
] as const;

export type ChangeType = (typeof CHANGE_TYPES)[number];

/**
 * A change type that may come from outside the default vocabulary.
 *
 * `(string & {})` keeps the eleven defaults in autocompletion while accepting
 * the types a repository declares for itself — the point of
 * {@link GitConvention.commit}`.types === 'any'`.
 */
export type ChangeTypeLike = ChangeType | (string & {});

/** Types that may prefix a branch. `style` and `revert` are commit-only. */
export const BRANCH_CHANGE_TYPES = [
  'feat',
  'fix',
  'docs',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
] as const;

export type BranchChangeType = (typeof BRANCH_CHANGE_TYPES)[number];

/**
 * Where {@link resolveChangeType} took the type from.
 *
 * Two rungs, not five: a type the repository declares — directly, or through
 * the label map it declares — and `feat`. Inferring a type from an Issue Type
 * name or a `[Bug]` title prefix produced a plausible answer with no observable
 * consequence, and was removed with the maps behind it.
 */
export type ChangeTypeSource = 'declared' | 'label' | 'fallback';

/**
 * How a commit message is rendered.
 *
 * `'free'` is the posture change of ADR-11: when the repository declares a
 * format of its own, Issue Flow stops writing one and hands the decision back.
 */
export type CommitFormat = 'conventional' | 'free';

/** Same distinction, for the Pull Request title. */
export type PrTitleFormat = 'conventional' | 'free';

/**
 * The types a commit may use: an explicit list, or `'any'` when the repository
 * declared a convention without enumerating them.
 */
export type CommitTypeVocabulary = readonly string[] | 'any';

/** Local merge strategy, for the worktree lifecycle. */
export type MergeStrategy = 'no-ff' | 'squash' | 'rebase';

/**
 * The canonical Git convention, resolved.
 *
 * One object per repository, produced by `resolveGitConvention()`. Every field
 * has a default so a repository that declares nothing still gets a usable
 * baseline; every field is replaced whole the moment the repository declares
 * its own.
 */
export interface GitConvention {
  branch: {
    /** `'{type}/{N}-{slug}'` by default; `'{slug}'` is the flat, prefix-free form. */
    pattern: string;
    maxLength: number;
    /**
     * Configuration of the generated-name path, or null when a name is only
     * ever derived from the issue. See `auto-name.ts`.
     */
    autoName: AutoNameConvention | null;
  };
  commit: {
    format: CommitFormat;
    types: CommitTypeVocabulary;
    /** Content of the repository's `commit.template`, when it ships one. */
    template: string | null;
    footer: { refs: boolean; signoff: boolean };
  };
  pullRequest: {
    titleFormat: PrTitleFormat;
    /** The repository's template always wins; null means it ships none. */
    bodyTemplate: string | null;
    closesWhenVerified: boolean;
  };
  merge: { strategy: MergeStrategy; cleanupWorktree: boolean };
}

/**
 * Knobs of the generated-branch-name path.
 *
 * Deliberately provider-free: which agent, model or CLI produces the name is
 * the caller's business, and naming a provider here would be exactly the
 * leakage this directory forbids.
 */
export interface AutoNameConvention {
  /** Overrides the default instruction handed to the generator. */
  systemPrompt?: string | null;
  /** Hard ceiling on the generated name. Defaults to 40, as upstream. */
  maxLength?: number;
  /** Deadline after which the deterministic fallback is used instead. */
  timeoutMs?: number;
}

export const DEFAULT_BRANCH_CONVENTION = '{type}/{N}-{slug}';

export const DEFAULT_COMMIT_PATTERN = '<type>(<scope>): <subject>';

export const DEFAULT_PR_TITLE_PATTERN = '<type>(<scope>): <subject>';

export const SLUG_MAX_LENGTH = 40;

export const BRANCH_MAX_LENGTH = 60;

/** Default label → type map. Overridable via `policy.git.typeMap`. */
export const DEFAULT_LABEL_TYPE_MAP: Readonly<Record<string, ChangeType>> = {
  bug: 'fix',
  documentation: 'docs',
  docs: 'docs',
  refactor: 'refactor',
  'tech-debt': 'refactor',
  infra: 'ci',
  'ci-cd': 'ci',
  enhancement: 'feat',
  architecture: 'feat',
  investigation: 'chore',
};

export const FORBIDDEN_PROVIDER_NAMES = [
  'claude',
  'codex',
  'cursor',
  'antigravity',
  'opencode',
] as const;

export interface ChangeTypeInput {
  labels?: readonly string[];
  typeMap?: Readonly<Record<string, string>> | null;
  /** Explicit type from a declared convention that already pins one. */
  declaredType?: ChangeTypeLike | null;
  /**
   * The vocabulary in force. Defaults to {@link CHANGE_TYPES}; a repository that
   * declares its own passes them, or `'any'` when it declares a convention
   * without enumerating the types.
   */
  allowedTypes?: CommitTypeVocabulary | null;
}

export interface ChangeTypeResult {
  type: ChangeTypeLike;
  source: ChangeTypeSource;
}

export interface BranchInput {
  type: ChangeTypeLike;
  issueNumber?: number | null;
  title: string;
  convention?: string;
  /** Defaults to {@link BRANCH_MAX_LENGTH}. */
  maxLength?: number;
  existingRefs?: readonly { name: string; oid: string }[];
  currentOid?: string;
}

export interface ParsedBranch {
  type: ChangeType | 'issue' | null;
  issueNumber: number | null;
  slug: string;
  raw: string;
}

export interface CommitInput {
  /**
   * `'conventional'` renders `<type>(<scope>)[!]: <subject>` and wraps the body.
   * `'free'` writes the subject and body exactly as given: the repository — or
   * the agent following it — already decided the format, and rewriting it is
   * the fallback behaving like a rule.
   */
  format?: CommitFormat;
  type: ChangeTypeLike;
  scope?: string | null;
  subject: string;
  body?: string;
  issueNumber?: number | null;
  breaking?: string | null;
  signoff?: string | boolean | null;
}

export interface PrTitleInput {
  /** `'free'` returns the subject untouched, as `commit.format` does. */
  format?: PrTitleFormat;
  type: ChangeTypeLike;
  scope?: string | null;
  subject: string;
  /** When consolidating several issues, the types of the set. */
  types?: readonly ChangeTypeLike[];
  scopes?: readonly (string | null | undefined)[];
}

export interface IssueReference {
  number: number;
  complete: boolean;
  container?: boolean;
  allChildrenComplete?: boolean;
}

export interface IssueRefInput {
  references: readonly IssueReference[];
}

export function isChangeType(value: string): value is ChangeType {
  return (CHANGE_TYPES as readonly string[]).includes(value);
}

/**
 * Whether `type` is usable under `vocabulary`.
 *
 * `'any'` is what a repository that declares its own convention gets: rejecting
 * a type the repository itself uses is the fallback overruling the rule it was
 * only supposed to stand in for.
 */
export function isAllowedType(
  value: string,
  vocabulary: CommitTypeVocabulary = CHANGE_TYPES,
): boolean {
  return vocabulary === 'any' ? value !== '' : vocabulary.includes(value);
}

export function isBranchChangeType(value: string): value is BranchChangeType {
  return (BRANCH_CHANGE_TYPES as readonly string[]).includes(value);
}

/** Provider names are valid subjects, never types or scopes. */
export function isForbiddenProviderToken(value: string): boolean {
  return (FORBIDDEN_PROVIDER_NAMES as readonly string[]).includes(value.toLowerCase());
}
