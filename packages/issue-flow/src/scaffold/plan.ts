import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_ISSUE_TYPES } from '../conventions/defaults.js';
import type { RepositoryPolicy } from '../policy/types.js';
import {
  renderAgentsMd,
  renderClaudeMd,
  renderConventionsDoc,
  renderIssueForm,
  renderIssueTemplateConfig,
  renderLabelsFile,
  renderPullRequestTemplate,
  type ScaffoldAsset,
} from './assets.js';

/**
 * Deciding what a repository is missing — the shared core behind both the CLI
 * and the initialization skill.
 *
 * The plan is produced from the **resolved policy**, never from a fresh scan:
 * initialization and every other flow therefore see the same repository, and a
 * convention that discovery already found can never be proposed a second time.
 *
 * Two properties matter more than the file list.
 *
 * **Non-destructive.** Nothing that exists is ever overwritten. A repository
 * that already declares a convention keeps it, even when it differs from the
 * default — the whole point of the tool is to adapt to the repository, and
 * "initialize" must not become a euphemism for "replace".
 *
 * **Idempotent.** Running it twice changes nothing the second time, because the
 * plan is computed from what is present rather than from what a previous run
 * did.
 */

/** What initialization intends to do with one file. */
export type ScaffoldActionKind =
  /** The file does not exist and the repository has no equivalent. */
  | 'create'
  /** Something equivalent already exists; initialization stays out of the way. */
  | 'keep'
  /**
   * Present, but inconsistent with the convention it claims to follow. Reported,
   * never rewritten: the repository may be right and the tool wrong.
   */
  | 'review';

export interface ScaffoldAction {
  path: string;
  kind: ScaffoldActionKind;
  tier: ScaffoldAsset['tier'];
  /** Why this action was chosen, in one sentence, for the report. */
  reason: string;
  /** Content to write. Only present for `create`. */
  content?: string;
}

export interface ScaffoldPlan {
  root: string;
  /** Every action, in a stable order. */
  actions: ScaffoldAction[];
  /** Notes that are not tied to a single file. */
  notes: string[];
}

/** Everything the plan needs to know about the repository's current state. */
export interface RepositoryState {
  policy: RepositoryPolicy;
  /** Whether a repository-relative path exists. */
  exists(relPath: string): Promise<boolean>;
  /** Name to head `AGENTS.md` with. */
  projectName: string;
}

function action(
  path: string,
  kind: ScaffoldActionKind,
  tier: ScaffoldAsset['tier'],
  reason: string,
  content?: string,
): ScaffoldAction {
  return content === undefined
    ? { path, kind, tier, reason }
    : { path, kind, tier, reason, content };
}

/**
 * Whether a `CLAUDE.md` is already the one-line bridge the convention asks for.
 *
 * A file that merely *mentions* `AGENTS.md` in the middle of its own
 * instructions is not a bridge — it is a second source that happens to cite the
 * first. The test is therefore about size and shape, not about a substring.
 */
export function isClaudeBridge(content: string): boolean {
  const meaningful = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  if (meaningful.length === 0 || meaningful.length > 2) return false;
  return meaningful.every((line) => /agents\.md/i.test(line));
}

/**
 * Build the plan.
 *
 * `write` is what the caller intends to do with it; the plan itself never
 * touches the filesystem, which is what lets the CLI show it and the skill
 * reason about it before anything happens.
 */
export async function buildScaffoldPlan(state: RepositoryState): Promise<ScaffoldPlan> {
  const { policy } = state;
  const actions: ScaffoldAction[] = [];
  const notes: string[] = [];

  // ── Issue Templates ───────────────────────────────────────────────────────
  const localTemplates = policy.issues.templates.filter((t) => t.origin === 'filesystem');
  const orgTemplates = policy.issues.templates.filter((t) => t.origin === 'organization');

  if (localTemplates.length > 0) {
    actions.push(
      action(
        '.github/ISSUE_TEMPLATE/',
        'keep',
        'required',
        `${localTemplates.length} Issue Template(s) already declared in this repository.`,
      ),
    );
  } else if (orgTemplates.length > 0) {
    // The organization already answered this, and a local copy would fork it:
    // the org file is then edited once and the repository silently stops
    // following it.
    actions.push(
      action(
        '.github/ISSUE_TEMPLATE/',
        'keep',
        'required',
        `The organization serves ${orgTemplates.length} Issue Template(s) to this repository; a local copy would fork them.`,
      ),
    );
    notes.push(
      'Issue Templates come from the organization. Change them there, not here — a local copy stops tracking the original the moment either is edited.',
    );
  } else {
    for (const type of DEFAULT_ISSUE_TYPES) {
      const path = `.github/ISSUE_TEMPLATE/${type.order}-${type.slug}.yml`;
      actions.push(
        action(
          path,
          'create',
          'required',
          `Issue Form for the "${type.name}" type.`,
          renderIssueForm(type),
        ),
      );
    }
    const configPath = '.github/ISSUE_TEMPLATE/config.yml';
    actions.push(
      action(
        configPath,
        (await state.exists(configPath)) ? 'keep' : 'create',
        'required',
        'Template chooser: keeps blank issues enabled and links the conventions.',
        renderIssueTemplateConfig(),
      ),
    );
  }

  // ── Pull Request template ────────────────────────────────────────────────
  if (policy.pullRequests.templates.length > 0) {
    actions.push(
      action(
        policy.pullRequests.templates[0]?.path ?? '.github/PULL_REQUEST_TEMPLATE.md',
        'keep',
        'required',
        'A Pull Request template already exists.',
      ),
    );
  } else {
    actions.push(
      action(
        '.github/PULL_REQUEST_TEMPLATE.md',
        'create',
        'required',
        'Gives every Pull Request a body that review can rely on.',
        renderPullRequestTemplate(),
      ),
    );
  }

  // ── Agent entry points ───────────────────────────────────────────────────
  const agents = policy.docs.find((doc) => doc.kind === 'agents' && doc.scope === '');
  const claude = policy.docs.find((doc) => doc.kind === 'claude' && doc.scope === '');

  const referenced = policy.docs
    .filter((doc) => doc.kind === 'contributing' || doc.kind === 'referenced')
    .map((doc) => doc.path);

  if (agents === undefined) {
    actions.push(
      action(
        'AGENTS.md',
        'create',
        'required',
        'The canonical entry point for any coding agent, as an index of the real documentation.',
        renderAgentsMd(state.projectName, referenced),
      ),
    );
  } else {
    actions.push(action('AGENTS.md', 'keep', 'required', 'Already the canonical entry point.'));
  }

  if (claude === undefined) {
    actions.push(
      action(
        'CLAUDE.md',
        'create',
        'recommended',
        'One-line bridge to AGENTS.md, so Claude Code reads the canonical source.',
        renderClaudeMd(),
      ),
    );
  } else if (isClaudeBridge(claude.content)) {
    actions.push(action('CLAUDE.md', 'keep', 'recommended', 'Already a bridge to AGENTS.md.'));
  } else if (agents === undefined) {
    // The common migration: instructions live in CLAUDE.md and there is no
    // AGENTS.md. Promoting the content is the user's call — the tool says so
    // rather than moving text it did not write.
    notes.push(
      'CLAUDE.md carries its own instructions and there is no AGENTS.md. Move that content into AGENTS.md and reduce CLAUDE.md to the one-line bridge; nothing here rewrites it for you.',
    );
    actions.push(
      action(
        'CLAUDE.md',
        'review',
        'recommended',
        'Holds instructions of its own; AGENTS.md should be the canonical source.',
      ),
    );
  } else {
    notes.push(
      'AGENTS.md and CLAUDE.md both carry instructions. Two copies of the same rules diverge the first time only one is edited — keep AGENTS.md and reduce CLAUDE.md to the one-line bridge.',
    );
    actions.push(
      action(
        'CLAUDE.md',
        'review',
        'recommended',
        'Duplicates instructions that AGENTS.md already owns.',
      ),
    );
  }

  // ── Documented conventions ───────────────────────────────────────────────
  const hasContributing = policy.docs.some((doc) => doc.kind === 'contributing');
  const conventionsPath = 'docs/conventions.md';
  const conventionsExists = await state.exists(conventionsPath);

  if (conventionsExists) {
    actions.push(
      action(conventionsPath, 'keep', 'recommended', 'Conventions are already documented.'),
    );
  } else if (orgTemplates.length > 0) {
    // The conventions are the organization's, and they are documented wherever
    // the organization documents them. A per-repository copy would be a second
    // source that drifts from the one everybody else follows.
    actions.push(
      action(
        conventionsPath,
        'keep',
        'recommended',
        "The conventions are the organization's; documenting them again here would fork them.",
      ),
    );
  } else if (hasContributing && localTemplates.length > 0) {
    // The repository already says how it works, in its own words and its own
    // file. A second document would be a competing source, which is the exact
    // failure this tool exists to avoid.
    actions.push(
      action(
        conventionsPath,
        'keep',
        'recommended',
        'CONTRIBUTING.md and the Issue Templates already document how this repository works.',
      ),
    );
  } else {
    actions.push(
      action(
        conventionsPath,
        'create',
        'recommended',
        'The source of truth for issue types, labels, branches and commits.',
        renderConventionsDoc(policy.issues.types.length > 0),
      ),
    );
  }

  // ── Labels ───────────────────────────────────────────────────────────────
  const labelsPath = '.github/labels.json';
  if (policy.issues.labels.length > 0) {
    actions.push(
      action(
        labelsPath,
        'keep',
        'contextual',
        `This repository already has ${policy.issues.labels.length} label(s); Issue Flow never rewrites a taxonomy.`,
      ),
    );
  } else if (await state.exists(labelsPath)) {
    actions.push(action(labelsPath, 'keep', 'contextual', 'A labels file already exists.'));
  } else {
    const includeTypeLabels = policy.issues.types.length === 0;
    actions.push(
      action(
        labelsPath,
        'create',
        'contextual',
        includeTypeLabels
          ? 'A baseline label set, including type labels because this organization has no Issue Types.'
          : 'A baseline label set. Type labels are omitted: this organization has native Issue Types.',
        renderLabelsFile(includeTypeLabels),
      ),
    );
  }

  if (policy.issues.types.length === 0) {
    notes.push(
      'No GitHub Issue Types were found. They are an organization-level setting and cannot be created from here; defining them there is better than the `type:*` labels this proposes as a fallback.',
    );
  }

  return { root: policy.root, actions, notes };
}

/** Load a repository file, or null. Used by the state adapter and by tests. */
export async function readIfPresent(root: string, relPath: string): Promise<string | null> {
  try {
    return await readFile(join(root, relPath), 'utf-8');
  } catch {
    return null;
  }
}
