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

/** Where {@link resolveChangeType} took the type from. */
export type ChangeTypeSource = 'declared' | 'issue-type' | 'label' | 'title' | 'fallback';

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

export const FORBIDDEN_PROVIDER_NAMES = ['claude', 'codex', 'cursor', 'antigravity'] as const;

export interface ChangeTypeInput {
  issueType?: string | null;
  labels?: readonly string[];
  title?: string;
  titleConvention?: string | null;
  typeMap?: Readonly<Record<string, string>> | null;
  /** Explicit type from a declared convention that already pins one. */
  declaredType?: ChangeType | null;
}

export interface ChangeTypeResult {
  type: ChangeType;
  source: ChangeTypeSource;
  /** Set when Issue Type and labels disagree; Issue Type still wins. */
  conflict?: { issueType: ChangeType; label: ChangeType };
}

export interface BranchInput {
  type: ChangeType;
  issueNumber?: number | null;
  title: string;
  convention?: string;
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
  type: ChangeType;
  scope?: string | null;
  subject: string;
  body?: string;
  issueNumber?: number | null;
  storyId?: string | null;
  breaking?: string | null;
  signoff?: string | boolean | null;
}

export interface PrTitleInput {
  type: ChangeType;
  scope?: string | null;
  subject: string;
  /** When consolidating several issues, the types of the set. */
  types?: readonly ChangeType[];
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

export function isBranchChangeType(value: string): value is BranchChangeType {
  return (BRANCH_CHANGE_TYPES as readonly string[]).includes(value);
}

/** Provider names are valid subjects, never types or scopes. */
export function isForbiddenProviderToken(value: string): boolean {
  return (FORBIDDEN_PROVIDER_NAMES as readonly string[]).includes(value.toLowerCase());
}
