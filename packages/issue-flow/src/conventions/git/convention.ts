import {
  BRANCH_MAX_LENGTH,
  CHANGE_TYPES,
  type CommitFormat,
  type CommitTypeVocabulary,
  DEFAULT_BRANCH_CONVENTION,
  type GitConvention,
  type PrTitleFormat,
} from './types.js';

/**
 * Resolving the one Git convention in force for a repository (ADR-11).
 *
 * > The repository declares → Issue Flow yields.
 * > The repository is silent → Issue Flow decides.
 *
 * The distinction that makes this safe is `declared` versus `inferred`
 * (`src/policy/`). A convention the repository *declares* — a commitlint
 * config, a `.gitmessage`, an explicit `policy.git` key — turns the Issue Flow
 * fallback off. A convention merely *inferred* from history informs the report
 * and changes nothing: guessing from four commits is not a mandate.
 */

/** Everything a resolved repository policy can say about Git, flattened. */
export interface GitConventionInput {
  branchConvention?: string | null;
  /** `'conventional'`, `'free'`, or free text a repository wrote for itself. */
  commitConvention?: string | null;
  pullRequestTitleConvention?: string | null;
  /** Content of the repository's `commit.template` (`.gitmessage`). */
  commitTemplate?: string | null;
  /** The vocabulary the repository enumerates, when it enumerates one. */
  allowedTypes?: readonly string[] | null;
  /** Body template of the repository's Pull Request template. */
  pullRequestTemplate?: string | null;
  issueReference?: string | null;
  signoff?: boolean | null;
  branchMaxLength?: number | null;
  /**
   * True when at least one of those values came from a `declared` source.
   * Absent means "inferred at best", which never disables a fallback.
   */
  declared?: boolean;
}

/** What a repository that declares nothing gets. */
export const DEFAULT_GIT_CONVENTION: GitConvention = {
  branch: { pattern: DEFAULT_BRANCH_CONVENTION, maxLength: BRANCH_MAX_LENGTH, autoName: null },
  commit: {
    format: 'conventional',
    types: CHANGE_TYPES,
    template: null,
    footer: { refs: true, signoff: false },
  },
  pullRequest: { titleFormat: 'conventional', bodyTemplate: null, closesWhenVerified: true },
  merge: { strategy: 'no-ff', cleanupWorktree: false },
};

/** A declaration names Conventional Commits, in any of the spellings in use. */
function declaresConventional(value: string): boolean {
  return /conventional/i.test(value);
}

function commitFormat(input: GitConventionInput): CommitFormat {
  const declaration = input.commitConvention?.trim() ?? '';

  // A template is a format the repository wrote down; imposing another over it
  // is precisely the fallback pretending to be a rule.
  if (input.declared === true && (input.commitTemplate ?? '') !== '') return 'free';

  if (declaration === '') return DEFAULT_GIT_CONVENTION.commit.format;
  if (declaration === 'free') return 'free';
  if (declaresConventional(declaration)) return 'conventional';
  // The repository declared something else, in its own words.
  return input.declared === true ? 'free' : DEFAULT_GIT_CONVENTION.commit.format;
}

function commitTypes(input: GitConventionInput): CommitTypeVocabulary {
  if (input.declared !== true) return DEFAULT_GIT_CONVENTION.commit.types;
  if (input.allowedTypes != null && input.allowedTypes.length > 0) return input.allowedTypes;
  // Declared, but without a list: the repository's own vocabulary is whatever it
  // uses, and rejecting a type it uses would be the fallback overruling it.
  return 'any';
}

function titleFormat(input: GitConventionInput): PrTitleFormat {
  const declaration = input.pullRequestTitleConvention?.trim() ?? '';
  if (declaration === '') return DEFAULT_GIT_CONVENTION.pullRequest.titleFormat;
  if (declaration === 'free') return 'free';
  if (declaresConventional(declaration)) return 'conventional';
  return input.declared === true ? 'free' : DEFAULT_GIT_CONVENTION.pullRequest.titleFormat;
}

/**
 * Collapse a repository's declarations into the single convention every
 * surface — CLI, prompts, Skills — reads.
 *
 * `closesWhenVerified` stays true whatever the repository says: whether the
 * Pull Request closes the issue is a function of the verification state, not a
 * naming preference, and it is one of the four rules §24 keeps precisely
 * because it is a guarantee rather than an aesthetic.
 */
export function resolveGitConvention(input: GitConventionInput = {}): GitConvention {
  const branchPattern = input.branchConvention?.trim();

  return {
    branch: {
      pattern:
        branchPattern === undefined || branchPattern === ''
          ? DEFAULT_GIT_CONVENTION.branch.pattern
          : branchPattern,
      maxLength: input.branchMaxLength ?? DEFAULT_GIT_CONVENTION.branch.maxLength,
      autoName: DEFAULT_GIT_CONVENTION.branch.autoName,
    },
    commit: {
      format: commitFormat(input),
      types: commitTypes(input),
      template: input.commitTemplate ?? null,
      footer: { refs: true, signoff: input.signoff === true },
    },
    pullRequest: {
      titleFormat: titleFormat(input),
      bodyTemplate: input.pullRequestTemplate ?? null,
      closesWhenVerified: DEFAULT_GIT_CONVENTION.pullRequest.closesWhenVerified,
    },
    merge: { ...DEFAULT_GIT_CONVENTION.merge },
  };
}
