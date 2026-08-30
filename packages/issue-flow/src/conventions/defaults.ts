/**
 * The default convention set — Issue Flow's fallback when a repository declares
 * nothing of its own.
 *
 * This is the **last** rung of the precedence ladder, and it only ever applies
 * where the repository, its organization and the user's configuration are all
 * silent. It exists so that a brand-new repository still gets a usable,
 * professional baseline instead of an empty one.
 *
 * Two rules shaped every choice here.
 *
 * **Native structure before textual convention.** The preference order is
 * `native feature > structured field > label > free text`. Anything GitHub
 * already models — the type of an issue, its priority, its state — is not
 * re-implemented as a title prefix or a label, because that creates a second
 * truth that ages on its own. GitHub's own defaults are `task`, `bug` and
 * `feature`, and an organization may define up to 25 Issue Types.
 *
 * **Do not fragment the backlog.** A type per flavour of work makes no query
 * better and every filter worse. Documentation, maintenance, refactoring and
 * technical debt are *characteristics*, not natures, and they belong on labels
 * over a real type.
 */

/** A default Issue Type, with the reasoning a template and a report can quote. */
export interface DefaultIssueType {
  /** Display name, matching GitHub's Issue Type casing convention. */
  name: string;
  /** Slug used for the Issue Form file name, prefixed by `order`. */
  slug: string;
  /** Order in the template chooser: capture first, execution last. */
  order: number;
  /** One line: what this type is. */
  summary: string;
  /**
   * Whether an issue of this type is executable once it is ready.
   *
   * The distinction matters more than it looks: an open issue is not approved
   * work. `Idea`, `Research` and `Epic` record intent and never authorize an
   * agent to start implementing.
   */
  executable: boolean;
  /** GitHub's own default types, which exist in every organization. */
  native: boolean;
}

/**
 * Six types, not thirteen.
 *
 * `Bug`, `Feature` and `Task` are GitHub's native defaults and cover all
 * executable work. `Idea`, `Research` and `Epic` are added because each answers
 * a question the other three cannot: *is this even worth doing*, *what is the
 * answer*, and *what is the umbrella*. Everything else the user might expect —
 * documentation, maintenance, refactor, technical debt, security, spike — is
 * deliberately **not** a type; see {@link NON_TYPES}.
 */
export const DEFAULT_ISSUE_TYPES: readonly DefaultIssueType[] = [
  {
    name: 'Idea',
    slug: 'idea',
    order: 1,
    summary: 'A hypothesis, opportunity or perceived problem, not yet analysed.',
    executable: false,
    native: false,
  },
  {
    name: 'Research',
    slug: 'research',
    order: 2,
    summary: 'An investigation that produces knowledge: analysis, benchmark, feasibility.',
    executable: false,
    native: false,
  },
  {
    name: 'Epic',
    slug: 'epic',
    order: 3,
    summary: 'An umbrella objective delivered through sub-issues.',
    executable: false,
    native: false,
  },
  {
    name: 'Feature',
    slug: 'feature',
    order: 4,
    summary: 'A new capability or a change to what the product does.',
    executable: true,
    native: true,
  },
  {
    name: 'Bug',
    slug: 'bug',
    order: 5,
    summary: 'Existing behaviour that diverges from what is expected.',
    executable: true,
    native: true,
  },
  {
    name: 'Task',
    slug: 'task',
    order: 6,
    summary: 'Concrete work that is neither a feature nor a bug.',
    executable: true,
    native: true,
  },
] as const;

/** Something people often expect to be a type, and why it is not one here. */
export interface NonType {
  concept: string;
  /** How to represent it instead. */
  instead: string;
  why: string;
}

/**
 * The list is as much a part of the convention as the types themselves: without
 * it, every repository re-derives the same six arguments and reaches a different
 * answer.
 */
export const NON_TYPES: readonly NonType[] = [
  {
    concept: 'Documentation',
    instead: '`Task` + label `docs`',
    why: 'The work is a task; what varies is the area it touches.',
  },
  {
    concept: 'Maintenance, chore',
    instead: '`Task`',
    why: 'That is already what `Task` means.',
  },
  {
    concept: 'Refactor, technical debt',
    instead: '`Task` + label `tech-debt`',
    why: 'A cross-cutting characteristic, not a distinct nature of work.',
  },
  {
    concept: 'Security',
    instead: 'the real type (`Bug`/`Task`/`Feature`) + label `security`',
    why: 'It cuts across every type; as a type it would hide whether the item is a flaw or preventive work.',
  },
  {
    concept: 'Spike, investigation',
    instead: '`Research`',
    why: 'The same concept under a different name.',
  },
  {
    concept: 'Enhancement',
    instead: '`Feature`',
    why: 'A change to what the product does is a feature, whether it is new or an improvement.',
  },
  {
    concept: 'Proposal, RFC',
    instead: '`Research`, and an ADR for the decision it produces',
    why: 'The issue carries the investigation; the decision belongs in a document that outlives it.',
  },
  {
    concept: 'Question',
    instead: 'a Discussion, or `Research` when it needs work',
    why: 'A question that needs no work is not a backlog item.',
  },
] as const;

/** A default label, with the reason it exists. */
export interface DefaultLabel {
  name: string;
  description: string;
  /** Hex colour without `#`, matching GitHub's palette conventions. */
  color: string;
}

/**
 * A deliberately small vocabulary, for what has **no native representation**:
 * technical area, component and cross-cutting characteristic.
 *
 * Nothing here duplicates a field. There is no `priority`, no `status`, no
 * `type` and no size label: GitHub models all four, and a label alongside a
 * field is a second truth that drifts. The one exception is
 * {@link FALLBACK_TYPE_LABELS}, for repositories whose organization has no Issue
 * Types at all.
 */
export const DEFAULT_LABELS: readonly DefaultLabel[] = [
  { name: 'api', description: 'Public interfaces and contracts', color: '006b75' },
  { name: 'backend', description: 'Server-side code', color: '5319e7' },
  { name: 'frontend', description: 'User-facing code', color: 'bfd4f2' },
  { name: 'database', description: 'Schema, queries and migrations', color: 'c2e0c6' },
  { name: 'infra', description: 'Infrastructure, CI and deployment', color: 'f9d0c4' },
  { name: 'docs', description: 'Documentation', color: '0075ca' },
  { name: 'security', description: 'Security or privacy impact', color: 'd93f0b' },
  {
    name: 'tech-debt',
    description: 'Debt paid down rather than capability added',
    color: 'e4e669',
  },
  { name: 'blocked', description: 'Waiting on something outside this repository', color: 'b60205' },
  { name: 'good first issue', description: 'Good for newcomers', color: '7057ff' },
] as const;

/**
 * Type labels, used **only** where the organization has no Issue Types.
 *
 * A repository that cannot use the native field still needs the type to be
 * queryable, and a label is the next best representation. The moment Issue Types
 * exist, these become the second truth the convention warns about — which is why
 * scaffolding proposes them only after finding none.
 */
export const FALLBACK_TYPE_LABELS: readonly DefaultLabel[] = DEFAULT_ISSUE_TYPES.map((type) => ({
  name: `type:${type.slug}`,
  description: type.summary,
  color: type.executable ? '1d76db' : 'd4c5f9',
}));

/**
 * The sections an issue body is expected to carry, by default.
 *
 * Kept short on purpose. A twelve-section template is excellent for an
 * architectural proposal and hostile to capturing an idea, and a form nobody
 * fills in honestly is worse than no form. Each default Issue Form asks only
 * what its type actually needs; this list is what the *prose* fallback uses when
 * a repository has no forms at all.
 */
export const DEFAULT_BODY_SECTIONS: readonly string[] = [
  'Context',
  'Problem',
  'Objective',
  'Scope',
  'Out of scope',
  'Acceptance criteria',
  'Dependencies',
  'Risks',
  'References',
] as const;

import { DEFAULT_BRANCH_CONVENTION } from './git/index.js';

export { DEFAULT_BRANCH_CONVENTION };

/**
 * Commit convention.
 *
 * Conventional Commits is the closest thing to a lingua franca, and it is what
 * makes a changelog and a semver bump derivable from the history — which is
 * exactly why the type must reflect the change instead of always being `feat`.
 */
export const DEFAULT_COMMIT_CONVENTION = 'Conventional Commits — type(scope): subject';

/**
 * Issue title convention.
 *
 * `null` on purpose: with Issue Types, a `[Bug]` prefix restates in text what a
 * structured field already carries. A repository whose organization has no Issue
 * Types may want one, and declares it.
 */
export const DEFAULT_ISSUE_TITLE_CONVENTION: string | null = null;

/** Everything above, as one object, for the report and the scaffolding plan. */
export const DEFAULT_CONVENTIONS = {
  issueTypes: DEFAULT_ISSUE_TYPES,
  nonTypes: NON_TYPES,
  labels: DEFAULT_LABELS,
  fallbackTypeLabels: FALLBACK_TYPE_LABELS,
  bodySections: DEFAULT_BODY_SECTIONS,
  branchConvention: DEFAULT_BRANCH_CONVENTION,
  commitConvention: DEFAULT_COMMIT_CONVENTION,
  issueTitleConvention: DEFAULT_ISSUE_TITLE_CONVENTION,
} as const;
