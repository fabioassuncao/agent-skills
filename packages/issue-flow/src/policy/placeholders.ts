import { loadPolicyConfig } from '../config.js';
import { DEFAULT_BRANCH_CONVENTION } from '../conventions/git/index.js';
import { getBaseBranch } from '../utils/git.js';
import { loadRepositoryPolicy } from './resolve.js';
import type { IssueTemplate, PolicyDocument, RepositoryPolicy } from './types.js';

/**
 * Projection of a {@link RepositoryPolicy} onto the prompt placeholders.
 *
 * The prompts receive a **summary**, never the raw files. Dumping
 * `CONTRIBUTING.md` and three `AGENTS.md` into every prompt would cost tokens on
 * every single run and drown the actual instruction — and it would duplicate,
 * inside Issue Flow, a rule that already lives in the repository.
 *
 * The whole projection is empty when the repository declares nothing, which is
 * what lets a prompt render byte for byte as it did before this layer existed.
 */

/** Every placeholder this module produces. Ordered as they appear in a prompt. */
export const POLICY_PLACEHOLDER_KEYS = [
  '__REPO_POLICY__',
  '__REPO_ISSUE_TEMPLATES__',
  '__REPO_LABELS__',
  '__REPO_ISSUE_TYPES__',
  '__REPO_PR_TEMPLATE__',
  '__REPO_BASE_BRANCH__',
  '__REPO_CONVENTIONS__',
  '__REPO_DOCS__',
] as const;

export type PolicyPlaceholderKey = (typeof POLICY_PLACEHOLDER_KEYS)[number];

/** Every placeholder empty — the projection of "this repository declares nothing". */
export function emptyPolicyPlaceholders(): Record<string, string> {
  return Object.fromEntries(POLICY_PLACEHOLDER_KEYS.map((key) => [key, ''])) as Record<
    string,
    string
  >;
}

/**
 * Rough token count of a rendered section.
 *
 * Four characters per token is the usual English/Portuguese approximation and is
 * deliberately crude: the budget exists to stop a policy from swallowing the
 * prompt, not to bill anyone. Erring high is the safe direction, so the estimate
 * rounds up.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Section renderers ───────────────────────────────────────────────────────

function renderIssueTemplates(templates: IssueTemplate[]): string {
  if (templates.length === 0) return '';

  const lines = templates.map((template) => {
    const parts = [`- **${template.name ?? template.path}** (\`${template.path}\`)`];
    if (template.type !== null) parts.push(`type: ${template.type}`);
    if (template.labels.length > 0) parts.push(`labels: ${template.labels.join(', ')}`);
    if (template.title !== null) parts.push(`title prefix: \`${template.title}\``);
    if (template.about !== null) parts.push(template.about);
    return parts.join(' — ');
  });

  return lines.join('\n');
}

function renderLabels(policy: RepositoryPolicy): string {
  if (policy.issues.labels.length === 0) return '';

  return policy.issues.labels
    .map((label) =>
      label.description === null ? `- ${label.name}` : `- ${label.name} — ${label.description}`,
    )
    .join('\n');
}

function renderConventions(policy: RepositoryPolicy): string {
  const rows: string[] = [];
  if (policy.issues.titleConvention !== null) {
    rows.push(`- Issue title: ${policy.issues.titleConvention}`);
  }
  if (policy.pullRequests.titleConvention !== null) {
    rows.push(`- Pull Request title: ${policy.pullRequests.titleConvention}`);
  }
  if (policy.git.branchConvention !== null) {
    rows.push(`- Branch: ${policy.git.branchConvention}`);
  }
  if (policy.git.commitConvention !== null) {
    rows.push(`- Commit: ${policy.git.commitConvention}`);
  }
  if (policy.git.pullRequestTitleConvention !== null) {
    rows.push(`- Pull Request title: ${policy.git.pullRequestTitleConvention}`);
  }
  if (policy.git.allowedTypes !== null && policy.git.allowedTypes.length > 0) {
    rows.push(`- Allowed types: ${policy.git.allowedTypes.join(', ')}`);
  }
  return rows.join('\n');
}

/**
 * Paths of the applicable documents — **never their content**.
 *
 * The agent has `Read` and fetches what it needs. Embedding the documents would
 * multiply the cost of every run and, worse, freeze a copy of the repository's
 * own rule inside a prompt.
 */
function renderDocs(docs: PolicyDocument[]): string {
  if (docs.length === 0) return '';

  return docs
    .map((doc) => {
      const scope = doc.scope === '' ? '' : ` (applies to \`${doc.scope}/\`)`;
      return `- \`${doc.path}\`${scope}`;
    })
    .join('\n');
}

// ── The budgeted summary ────────────────────────────────────────────────────

interface Section {
  /** Heading inside the summary. */
  title: string;
  body: string;
  /**
   * Kept whole even when the budget is blown. The essentials are the taxonomy
   * an agent cannot guess: it can re-read a document, but it cannot invent the
   * label a repository actually uses.
   */
  essential: boolean;
  /** Shown in place of the body once the budget is exhausted. */
  pointer: string;
}

/**
 * Compose `__REPO_POLICY__` within `budgetTokens`.
 *
 * Sections are added whole, in priority order, while they fit. A section that
 * does not fit is replaced **whole** by a pointer to where the agent can read it
 * — nothing is ever cut mid-sentence, because a summary truncated mid-rule is
 * worse than one that says where the rule lives.
 */
export function renderPolicySummary(policy: RepositoryPolicy, budgetTokens: number): string {
  const sections: Section[] = [
    {
      title: 'Base branch',
      body: policy.pullRequests.baseBranch ?? '',
      essential: true,
      pointer: '',
    },
    {
      title: 'Conventions',
      body: renderConventions(policy),
      essential: true,
      pointer: '',
    },
    {
      title: 'Issue Types',
      body: policy.issues.types.join(', '),
      essential: true,
      pointer: '',
    },
    {
      title: 'Issue Templates',
      body: renderIssueTemplates(policy.issues.templates),
      essential: true,
      pointer: 'Run `issue-flow policy --json` to read the templates in full.',
    },
    {
      title: 'Labels',
      body: renderLabels(policy),
      essential: true,
      pointer: 'Run `gh label list` to read the labels of this repository.',
    },
    {
      title: 'Pull Request template',
      body: policy.pullRequests.templates[0]?.path ?? '',
      essential: false,
      pointer: '',
    },
    {
      title: 'Policy documents',
      body: renderDocs(policy.docs),
      essential: false,
      pointer: '',
    },
  ];

  const rendered: string[] = [];
  let used = 0;

  for (const section of sections) {
    if (section.body.trim() === '') continue;

    const block = `### ${section.title}\n\n${section.body}`;
    const cost = estimateTokens(block);

    if (used + cost <= budgetTokens) {
      rendered.push(block);
      used += cost;
      continue;
    }

    // Over budget. An essential section keeps its slot as a pointer; a
    // non-essential one simply drops out.
    if (section.essential && section.pointer !== '') {
      const fallback = `### ${section.title}\n\n${section.pointer}`;
      rendered.push(fallback);
      used += estimateTokens(fallback);
    }
  }

  return rendered.join('\n\n');
}

/** True when the policy carries nothing a prompt could act on. */
export function isEmptyPolicy(policy: RepositoryPolicy): boolean {
  return (
    policy.issues.templates.length === 0 &&
    policy.issues.types.length === 0 &&
    policy.issues.labels.length === 0 &&
    policy.issues.titleConvention === null &&
    policy.pullRequests.templates.length === 0 &&
    policy.pullRequests.baseBranch === null &&
    policy.pullRequests.titleConvention === null &&
    policy.git.branchConvention === null &&
    policy.git.commitConvention === null &&
    policy.docs.length === 0
  );
}

export interface PolicyPlaceholderOptions {
  /** Token budget for `__REPO_POLICY__`. Defaults to the resolved configuration. */
  budgetTokens?: number;
}

/**
 * Project a resolved policy onto the prompt placeholders.
 *
 * A `null` policy — or one that carries nothing — yields every placeholder
 * empty, which is what makes the rendered prompt identical to the pre-policy
 * one. This is the contract the whole feature rests on.
 */
export function policyPlaceholders(
  policy: RepositoryPolicy | null,
  options: PolicyPlaceholderOptions = {},
): Record<string, string> {
  if (policy === null || !policy.enabled || isEmptyPolicy(policy)) {
    return emptyPolicyPlaceholders();
  }

  const budget = options.budgetTokens ?? DEFAULT_POLICY_CONTEXT_BUDGET;

  return {
    __REPO_POLICY__: renderPolicySummary(policy, budget),
    __REPO_ISSUE_TEMPLATES__: renderIssueTemplates(policy.issues.templates),
    __REPO_LABELS__: renderLabels(policy),
    __REPO_ISSUE_TYPES__: policy.issues.types.join(', '),
    // The one place a whole file is projected verbatim: a Pull Request body has
    // to *be* the template, so a summary of it would be useless.
    __REPO_PR_TEMPLATE__: policy.pullRequests.template ?? '',
    __REPO_BASE_BRANCH__: policy.pullRequests.baseBranch ?? '',
    __REPO_CONVENTIONS__: renderConventions(policy),
    __REPO_DOCS__: renderDocs(policy.docs),
  };
}

/** Default token budget for `__REPO_POLICY__`, overridable via `policy.contextBudget`. */
export const DEFAULT_POLICY_CONTEXT_BUDGET = 1500;

// ── Conventions that always have a value ────────────────────────────────────

export { DEFAULT_BRANCH_CONVENTION } from '../conventions/git/index.js';

/**
 * Placeholders that must **never** render empty, because a prompt puts them
 * inside a command it asks the agent to run.
 *
 * `__BASE_BRANCH__` is the reason this group exists separately from the policy
 * projection. `prompts/pr.md` used to spell `main` three times — in
 * `git log main..HEAD`, in `git diff main...HEAD` and in `gh pr create --base
 * main`. In a repository whose base is `develop` that is not a missing feature
 * but an active defect: `main` often *exists* there too, so nothing fails — the
 * agent simply reviews the wrong diff and opens the Pull Request against the
 * wrong target.
 *
 * The resolution order is the repository's declared or discovered base, then
 * `getBaseBranch()`, whose own fallback is `main`. So a repository on `main`
 * renders exactly the text it rendered before.
 */
export function conventionPlaceholders(
  policy: RepositoryPolicy | null,
  baseBranchFallback: string,
): Record<string, string> {
  return {
    __BASE_BRANCH__: policy?.pullRequests.baseBranch ?? baseBranchFallback,
    __BRANCH_CONVENTION__: policy?.git.branchConvention ?? DEFAULT_BRANCH_CONVENTION,
    // The one member of this group that may legitimately render empty: it gates
    // a conditional section rather than sitting inside a command.
    __COMMIT_CONVENTION__: policy?.git.commitConvention ?? '',
  };
}

export interface ResolvePolicyPlaceholdersOptions {
  remote?: boolean;
  /** Repository root. Defaults to the git project root. */
  root?: string;
  /** Subdirectory the policy applies to, for monorepos. */
  scope?: string | null;
}

/**
 * Resolve the repository policy and project it, in one call.
 *
 * This is what every command uses. It **never throws and never warns**: a
 * repository that is not a git checkout, a discovery that fails, a `gh` that is
 * not installed — all of them yield the empty projection, and the command runs
 * exactly as it did before.
 *
 * The resolution itself is cached per `(root, scope)` by `loadRepositoryPolicy`,
 * so a pipeline that renders eight prompts still discovers once.
 */
export async function resolvePolicyPlaceholders(
  options: ResolvePolicyPlaceholdersOptions = {},
): Promise<Record<string, string>> {
  let policy: RepositoryPolicy | null = null;
  let projection = emptyPolicyPlaceholders();
  try {
    policy = await loadRepositoryPolicy({
      root: options.root,
      scope: options.scope ?? null,
      remote: options.remote,
    });
    const config = await loadPolicyConfig({ projectRoot: policy.root });
    projection = policyPlaceholders(policy, { budgetTokens: config.contextBudget });
  } catch {
    // Discovery is an enrichment; the conventions below still have to resolve.
    policy = null;
  }

  let fallbackBase = 'main';
  try {
    if (options.remote !== false) fallbackBase = await getBaseBranch();
  } catch {
    // getBaseBranch() does not throw today, but its contract is "never fails",
    // and a base branch that cannot be resolved must not cost the whole prompt.
  }

  return { ...projection, ...conventionPlaceholders(policy, fallbackBase) };
}
