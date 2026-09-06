import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { run } from '../utils/shell.js';
import { classifyDocument, extractReferencedDocuments } from './parsers/docs.js';
import {
  COMMITLINT_FILE_NAMES,
  type DiscoveredGitConventions,
  parseBranchHistory,
  parseChangesetConfig,
  parseCommitHistory,
  parseCommitlintText,
  parseCommitTemplate,
  parseHuskyCommitMsg,
  parsePackageJsonCommitlint,
  parseReleasePlease,
  parseSemanticPullRequestWorkflow,
  parseSemanticRelease,
} from './parsers/git.js';
import { parseIssueTypes, parseLabels } from './parsers/labels.js';
import {
  parseIssueTemplateFile,
  parseOrganizationForms,
  parseOrganizationTemplates,
} from './parsers/templates.js';
import {
  type IssueTemplate,
  type LabelDefinition,
  MAX_POLICY_DOCUMENT_BYTES,
  type PolicyDocument,
  type PolicyExec,
  type PolicySource,
  type PullRequestTemplate,
} from './types.js';

/**
 * Locating the policy sources of a repository on disk and, when `gh` can
 * answer, on GitHub.
 *
 * Every function here is best-effort by construction: an unreadable directory,
 * a missing binary, a network that never answers and a repository that simply
 * declares nothing all produce the same thing — an empty result plus, when the
 * source *could* have answered, a `PolicySource` recording why it did not.
 * Discovery must never be able to break a flow that works offline today.
 */

/**
 * Timeout of every `gh` and `git` invocation. Matches the `init` prerequisite
 * probes; the point is that no discovery call can hang a pipeline.
 */
export const DISCOVERY_TIMEOUT_MS = 10_000;

/** The directories GitHub itself looks in, in the order it looks. */
const POLICY_DIRECTORIES = ['.github', '', 'docs'] as const;

const defaultExec: PolicyExec = (command, args, options) =>
  run(command, args, { cwd: options.cwd, timeout: options.timeout });

/** Repository-relative path with POSIX separators, for stable output. */
export function toRelativePath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

/** Directory entries, or [] when the directory is absent or unreadable. */
async function listDirectory(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read a file, capped at {@link MAX_POLICY_DOCUMENT_BYTES}.
 *
 * Returns null when the file is absent or unreadable. The second element says
 * whether the content was truncated, so the caller can record it in `sources`
 * instead of silently handing a half document to an agent.
 */
async function readCapped(path: string): Promise<{ content: string; truncated: boolean } | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return null;
  }

  if (Buffer.byteLength(raw, 'utf-8') <= MAX_POLICY_DOCUMENT_BYTES) {
    return { content: raw, truncated: false };
  }
  const clipped = Buffer.from(raw, 'utf-8')
    .subarray(0, MAX_POLICY_DOCUMENT_BYTES)
    .toString('utf-8');
  return { content: clipped, truncated: true };
}

/** Find an entry of `dir` whose name matches one of `names`, case-insensitively. */
async function findFile(dir: string, names: string[]): Promise<string | null> {
  const entries = await listDirectory(dir);
  const wanted = names.map((name) => name.toLowerCase());
  for (const name of wanted) {
    const hit = entries.find((entry) => entry.toLowerCase() === name);
    if (hit !== undefined) return hit;
  }
  return null;
}

// ── Issue Templates and Forms ───────────────────────────────────────────────

const TEMPLATE_EXTENSIONS = ['.yml', '.yaml', '.md', '.markdown'];

/** The chooser configuration is not a template. */
function isTemplateFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === 'config.yml' || lower === 'config.yaml') return false;
  return TEMPLATE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export interface IssueTemplateDiscovery {
  templates: IssueTemplate[];
  sources: PolicySource[];
}

/**
 * Issue Templates and Forms of the local tree.
 *
 * Searched in `.github/ISSUE_TEMPLATE/`, the repository root and `docs/`, plus
 * the single-file `ISSUE_TEMPLATE.md` variant of each — the three locations
 * GitHub honours. Files are sorted by name so two runs over the same tree
 * produce the same order.
 */
export async function discoverIssueTemplates(root: string): Promise<IssueTemplateDiscovery> {
  const templates: IssueTemplate[] = [];
  const sources: PolicySource[] = [];

  for (const base of POLICY_DIRECTORIES) {
    const baseDir = base === '' ? root : join(root, base);

    const templateDir = (await findDirectory(baseDir, 'ISSUE_TEMPLATE')) ?? null;
    if (templateDir !== null) {
      const names = (await listDirectory(templateDir)).filter(isTemplateFile).sort();
      for (const name of names) {
        const filePath = join(templateDir, name);
        const file = await readCapped(filePath);
        if (file === null) continue;
        const relPath = toRelativePath(root, filePath);
        templates.push(parseIssueTemplateFile(relPath, file.content));
        sources.push({
          kind: 'issue-templates',
          origin: 'filesystem',
          path: relPath,
          status: 'found',
          detail: file.truncated ? 'content truncated' : null,
        });
      }
    }

    const singleFile = await findFile(baseDir, [
      'ISSUE_TEMPLATE.md',
      'ISSUE_TEMPLATE.yml',
      'ISSUE_TEMPLATE.yaml',
      'ISSUE_TEMPLATE.markdown',
    ]);
    if (singleFile !== null) {
      const filePath = join(baseDir, singleFile);
      const file = await readCapped(filePath);
      if (file !== null) {
        const relPath = toRelativePath(root, filePath);
        templates.push(parseIssueTemplateFile(relPath, file.content));
        sources.push({
          kind: 'issue-templates',
          origin: 'filesystem',
          path: relPath,
          status: 'found',
          detail: file.truncated ? 'content truncated' : null,
        });
      }
    }
  }

  return { templates, sources };
}

/** Case-insensitive lookup of a subdirectory, returning its real path. */
async function findDirectory(parent: string, name: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = (await readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  const hit = entries.find((entry) => entry.toLowerCase() === name.toLowerCase());
  return hit === undefined ? null : join(parent, hit);
}

// ── Pull Request template ───────────────────────────────────────────────────

const PR_TEMPLATE_FILES = [
  'PULL_REQUEST_TEMPLATE.md',
  'PULL_REQUEST_TEMPLATE.markdown',
  'PULL_REQUEST_TEMPLATE.txt',
  'PULL_REQUEST_TEMPLATE',
];

export interface PullRequestTemplateDiscovery {
  templates: PullRequestTemplate[];
  sources: PolicySource[];
}

/**
 * Pull Request templates, in every layout GitHub supports: the single file in
 * `.github/`, the root or `docs/`, and the `PULL_REQUEST_TEMPLATE/` directory
 * that holds several named ones.
 *
 * The first template found is the default one; the rest are kept so a caller
 * can offer the choice the repository set up.
 */
export async function discoverPullRequestTemplates(
  root: string,
): Promise<PullRequestTemplateDiscovery> {
  const templates: PullRequestTemplate[] = [];
  const sources: PolicySource[] = [];

  const collect = async (filePath: string): Promise<void> => {
    const file = await readCapped(filePath);
    if (file === null) return;
    const relPath = toRelativePath(root, filePath);
    templates.push({
      path: relPath,
      name: relPath.split('/').pop() ?? relPath,
      content: file.content,
    });
    sources.push({
      kind: 'pull-request-template',
      origin: 'filesystem',
      path: relPath,
      status: 'found',
      detail: file.truncated ? 'content truncated' : null,
    });
  };

  for (const base of POLICY_DIRECTORIES) {
    const baseDir = base === '' ? root : join(root, base);

    const single = await findFile(baseDir, PR_TEMPLATE_FILES);
    if (single !== null && !(await isDirectory(join(baseDir, single)))) {
      await collect(join(baseDir, single));
    }

    const templateDir = await findDirectory(baseDir, 'PULL_REQUEST_TEMPLATE');
    if (templateDir !== null) {
      for (const name of (await listDirectory(templateDir)).sort()) {
        if (!/\.(md|markdown|txt)$/i.test(name)) continue;
        await collect(join(templateDir, name));
      }
    }
  }

  return { templates, sources };
}

// ── CODEOWNERS ──────────────────────────────────────────────────────────────

export interface CodeownersDiscovery {
  content: string | null;
  sources: PolicySource[];
}

export async function discoverCodeowners(root: string): Promise<CodeownersDiscovery> {
  for (const base of POLICY_DIRECTORIES) {
    const baseDir = base === '' ? root : join(root, base);
    const name = await findFile(baseDir, ['CODEOWNERS']);
    if (name === null) continue;

    const file = await readCapped(join(baseDir, name));
    if (file === null) continue;

    const relPath = toRelativePath(root, join(baseDir, name));
    return {
      content: file.content,
      sources: [
        {
          kind: 'codeowners',
          origin: 'filesystem',
          path: relPath,
          status: 'found',
          detail: file.truncated ? 'content truncated' : null,
        },
      ],
    };
  }

  return { content: null, sources: [] };
}

// ── Policy documents ────────────────────────────────────────────────────────

/** Root-only documents: GitHub reads these from one place, not per directory. */
const ROOT_DOCUMENT_FILES = ['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md'];

/** Per-directory agent instructions, composed from the root down to the scope. */
const SCOPED_DOCUMENT_FILES = ['AGENTS.md', 'CLAUDE.md'];

export interface DocumentDiscovery {
  documents: PolicyDocument[];
  sources: PolicySource[];
}

/**
 * The scope ladder: `''`, then every ancestor of `scope`, then `scope` itself.
 * Composing in this order is what makes the more specific document win — it is
 * simply the later one.
 */
export function scopeLadder(scope: string | null): string[] {
  if (scope === null || scope === '') return [''];

  const segments = scope.split('/').filter((segment) => segment !== '');
  const ladder = [''];
  let current = '';
  for (const segment of segments) {
    current = current === '' ? segment : `${current}/${segment}`;
    ladder.push(current);
  }
  return ladder;
}

/**
 * Agent instructions and governance documents applying to `scope`.
 *
 * `AGENTS.md` (the open standard) and `CLAUDE.md` are read at every level of
 * the ladder, root first, so a monorepo's `apps/api/AGENTS.md` arrives after —
 * and therefore wins over — the one at the root. `CONTRIBUTING.md` and
 * `CODE_OF_CONDUCT.md` are read once, at the root, because that is where
 * GitHub reads them from.
 *
 * Documents linked from an `AGENTS.md` or a `CLAUDE.md` are followed one level;
 * see {@link extractReferencedDocuments} for why that is a link walk rather than
 * a scan of `docs/`.
 */
export async function discoverDocuments(
  root: string,
  scope: string | null,
): Promise<DocumentDiscovery> {
  const documents: PolicyDocument[] = [];
  const sources: PolicySource[] = [];
  const seen = new Set<string>();

  const collect = async (
    filePath: string,
    kind: PolicyDocument['kind'],
    docScope: string,
    referencedFrom: string | null,
  ): Promise<PolicyDocument | null> => {
    const relPath = toRelativePath(root, filePath);
    if (seen.has(relPath)) return null;

    const file = await readCapped(filePath);
    if (file === null) return null;
    seen.add(relPath);

    const document: PolicyDocument = {
      path: relPath,
      kind,
      scope: docScope,
      referencedFrom,
      content: file.content,
    };
    documents.push(document);
    sources.push({
      kind: 'docs',
      origin: 'filesystem',
      path: relPath,
      status: 'found',
      detail: file.truncated ? 'content truncated' : null,
    });
    return document;
  };

  for (const base of POLICY_DIRECTORIES) {
    const baseDir = base === '' ? root : join(root, base);
    for (const wanted of ROOT_DOCUMENT_FILES) {
      const name = await findFile(baseDir, [wanted]);
      if (name === null) continue;
      const kind = classifyDocument(name);
      if (kind === null) continue;
      await collect(join(baseDir, name), kind, '', null);
    }
  }

  const indexes: PolicyDocument[] = [];
  for (const level of scopeLadder(scope)) {
    const levelDir = level === '' ? root : join(root, level);
    for (const wanted of SCOPED_DOCUMENT_FILES) {
      const name = await findFile(levelDir, [wanted]);
      if (name === null) continue;
      const kind = classifyDocument(name);
      if (kind === null) continue;
      const document = await collect(join(levelDir, name), kind, level, null);
      // Both agent-instruction files are indexes. A `CLAUDE.md` whose entire
      // content is "Read and follow the instructions in AGENTS.md" is a real and
      // common shape: stopping at it would report a repository that declares
      // nothing, when in fact it forwards everything.
      if (document !== null && (kind === 'agents' || kind === 'claude')) {
        indexes.push(document);
      }
    }
  }

  // One level only: a referenced document that itself links onwards does not
  // drag its own bibliography into the context.
  for (const index of indexes) {
    for (const target of extractReferencedDocuments(index.content, index.path)) {
      await collect(join(root, target), 'referenced', index.scope, index.path);
    }
  }

  return { documents, sources };
}

// ── git ─────────────────────────────────────────────────────────────────────

export interface GitConventionDiscovery {
  commitConvention: string | null;
  pullRequestTitleConvention: string | null;
  branchConvention: string | null;
  commitTemplate: string | null;
  allowedTypes: string[] | null;
  scopes: string[] | null;
  /** True when at least one source was `declared` rather than `inferred` (§11). */
  declared: boolean;
  sources: PolicySource[];
}

function asPolicySources(discovered: DiscoveredGitConventions): PolicySource[] {
  return discovered.sources.map((entry) => ({
    kind: 'git-conventions' as const,
    origin: entry.confidence === 'inferred' ? ('git' as const) : ('filesystem' as const),
    path: entry.path,
    status: entry.confidence,
    detail: entry.detail,
  }));
}

/**
 * Discover the commit, Pull Request and branch conventions of the repository.
 *
 * Two tiers, and the boundary between them is what makes it safe to stop
 * imposing a default. Files the repository ships — commitlint, release-please,
 * semantic-release, changesets, a husky hook, a CI job, `commit.template` — are
 * `declared`, and a declaration turns the Issue Flow fallback off. History —
 * recent commit subjects, existing branch names — is `inferred`, and only ever
 * informs the report.
 *
 * Declarative files are parsed; `.js`/`.ts` configs are read as text only.
 */
export async function discoverGitConventions(
  root: string,
  exec: PolicyExec = defaultExec,
): Promise<GitConventionDiscovery> {
  let merged: DiscoveredGitConventions = {
    commitConvention: null,
    pullRequestTitleConvention: null,
    branchConvention: null,
    commitTemplate: null,
    allowedTypes: null,
    scopes: null,
    sources: [],
  };

  const take = (extra: DiscoveredGitConventions | null): void => {
    if (extra === null) return;
    merged = {
      commitConvention: merged.commitConvention ?? extra.commitConvention,
      pullRequestTitleConvention:
        merged.pullRequestTitleConvention ?? extra.pullRequestTitleConvention,
      branchConvention: merged.branchConvention ?? extra.branchConvention,
      commitTemplate: merged.commitTemplate ?? extra.commitTemplate,
      allowedTypes: merged.allowedTypes ?? extra.allowedTypes,
      scopes: merged.scopes ?? extra.scopes,
      sources: [...merged.sources, ...extra.sources],
    };
  };

  const pkg = await readCapped(join(root, 'package.json'));
  if (pkg !== null) {
    take(parsePackageJsonCommitlint(pkg.content));
  }

  for (const name of COMMITLINT_FILE_NAMES) {
    const found = await findFile(root, [name]);
    if (found === null) continue;
    const file = await readCapped(join(root, found));
    if (file === null) continue;
    take(parseCommitlintText(file.content, found));
  }

  for (const name of ['release-please-config.json', '.release-please-manifest.json']) {
    const found = await findFile(root, [name]);
    if (found === null) continue;
    const file = await readCapped(join(root, found));
    if (file === null) continue;
    take(parseReleasePlease(file.content, found));
  }

  for (const name of [
    '.releaserc',
    '.releaserc.json',
    '.releaserc.yaml',
    '.releaserc.yml',
    'release.config.js',
  ]) {
    const found = await findFile(root, [name]);
    if (found === null) continue;
    take(parseSemanticRelease(found));
  }

  const changeset = await findFile(join(root, '.changeset'), ['config.json']);
  if (changeset !== null) {
    take(parseChangesetConfig(`.changeset/${changeset}`));
  }

  const husky = await findFile(join(root, '.husky'), ['commit-msg']);
  if (husky !== null) {
    take(parseHuskyCommitMsg(`.husky/${husky}`));
  }

  const workflowDir = join(root, '.github', 'workflows');
  for (const name of await listDirectory(workflowDir)) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const file = await readCapped(join(workflowDir, name));
    if (file === null) continue;
    take(parseSemanticPullRequestWorkflow(file.content, `.github/workflows/${name}`));
  }

  const template = await readCommitTemplate(root, exec);
  if (template !== null) {
    take(parseCommitTemplate(template.content, template.path));
  }

  // History is consulted last and never overrules a file: `take()` keeps the
  // first answer, and every declaration was already offered above.
  take(parseCommitHistory(await readRecentSubjects(root, exec), 'git log'));
  take(parseBranchHistory(await readLocalBranches(root, exec), 'git for-each-ref refs/heads'));

  return {
    commitConvention: merged.commitConvention,
    pullRequestTitleConvention: merged.pullRequestTitleConvention,
    branchConvention: merged.branchConvention,
    commitTemplate: merged.commitTemplate,
    allowedTypes: merged.allowedTypes,
    scopes: merged.scopes,
    declared: merged.sources.some((entry) => entry.confidence === 'declared'),
    sources: asPolicySources(merged),
  };
}

/** How many commits the history inference looks at. Enough to be stable, cheap to read. */
const COMMIT_HISTORY_SAMPLE = 30;

/** How many branches the branch inference looks at. */
const BRANCH_HISTORY_SAMPLE = 30;

/**
 * The repository's `commit.template`.
 *
 * `git config` is asked first because that is where the setting actually lives;
 * `.gitmessage` at the root is the convention almost everyone uses to ship it,
 * and is read directly so the discovery still works without a git binary.
 */
async function readCommitTemplate(
  root: string,
  exec: PolicyExec,
): Promise<{ content: string; path: string } | null> {
  try {
    const configured = await exec('git', ['config', '--get', 'commit.template'], {
      cwd: root,
      timeout: DISCOVERY_TIMEOUT_MS,
    });
    const declared = configured.exitCode === 0 ? configured.stdout.trim() : '';
    if (declared !== '') {
      const file = await readCapped(isAbsolute(declared) ? declared : join(root, declared));
      if (file !== null) return { content: file.content, path: declared };
    }
  } catch {
    // No git, or a repository git refuses to answer for: fall through to the file.
  }

  for (const name of ['.gitmessage', '.gitmessage.txt']) {
    const found = await findFile(root, [name]);
    if (found === null) continue;
    const file = await readCapped(join(root, found));
    if (file !== null) return { content: file.content, path: found };
  }
  return null;
}

/** Recent commit subjects, or [] when git cannot answer. */
async function readRecentSubjects(root: string, exec: PolicyExec): Promise<string[]> {
  try {
    const result = await exec(
      'git',
      ['log', `-n${COMMIT_HISTORY_SAMPLE}`, '--no-merges', '--format=%s'],
      { cwd: root, timeout: DISCOVERY_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) return [];
    return result.stdout.split('\n');
  } catch {
    return [];
  }
}

/** Local branch names, or [] when git cannot answer. */
async function readLocalBranches(root: string, exec: PolicyExec): Promise<string[]> {
  try {
    const result = await exec(
      'git',
      [
        'for-each-ref',
        `--count=${BRANCH_HISTORY_SAMPLE}`,
        '--sort=-committerdate',
        '--format=%(refname:short)',
        'refs/heads',
      ],
      { cwd: root, timeout: DISCOVERY_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) return [];
    return result.stdout.split('\n');
  } catch {
    return [];
  }
}

export interface BaseBranchDiscovery {
  baseBranch: string | null;
  sources: PolicySource[];
}

/**
 * The repository's base branch, as git actually knows it.
 *
 * Unlike `utils/git.ts`'s `getBaseBranch()`, this never falls back to `'main'`:
 * a discovery layer that invents a value is indistinguishable from one that
 * found it, and `sources` would be lying. An undetermined base branch is null,
 * and the configuration layer above is free to declare one.
 */
export async function discoverBaseBranch(
  root: string,
  exec: PolicyExec = defaultExec,
): Promise<BaseBranchDiscovery> {
  const options = { cwd: root, timeout: DISCOVERY_TIMEOUT_MS };

  try {
    const remoteHead = await exec(
      'git',
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      options,
    );
    if (remoteHead.exitCode === 0) {
      const name = remoteHead.stdout.trim().replace(/^origin\//, '');
      if (name !== '') {
        return {
          baseBranch: name,
          sources: [
            {
              kind: 'base-branch',
              origin: 'git',
              path: null,
              status: 'found',
              detail: 'origin/HEAD',
            },
          ],
        };
      }
    }

    for (const candidate of ['main', 'master']) {
      const check = await exec(
        'git',
        ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`],
        options,
      );
      if (check.exitCode === 0) {
        return {
          baseBranch: candidate,
          sources: [
            {
              kind: 'base-branch',
              origin: 'git',
              path: null,
              status: 'found',
              detail: `refs/heads/${candidate}`,
            },
          ],
        };
      }
    }
  } catch {
    return {
      baseBranch: null,
      sources: [
        {
          kind: 'base-branch',
          origin: 'git',
          path: null,
          status: 'unavailable',
          detail: 'git could not be executed',
        },
      ],
    };
  }

  return { baseBranch: null, sources: [] };
}

/**
 * `owner` and `repo` of the `origin` remote, with their original case.
 *
 * Deliberately derived from git rather than from `gh repo view`: the identity
 * is already on disk, and spending a network round-trip on it would break the
 * "at most one `gh` call per kind of data" budget for nothing.
 */
export async function discoverGitHubSlug(
  root: string,
  exec: PolicyExec = defaultExec,
): Promise<{ owner: string; repo: string } | null> {
  let url = '';
  try {
    const result = await exec('git', ['remote', 'get-url', 'origin'], {
      cwd: root,
      timeout: DISCOVERY_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return null;
    url = result.stdout.trim();
  } catch {
    return null;
  }
  if (url === '') return null;

  // Both the scp-like shorthand and every URL scheme end in `<owner>/<repo>`.
  const match = /[/:]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { owner: match[1], repo: match[2] };
}

// ── GitHub, via gh ──────────────────────────────────────────────────────────

/** One `gh` call, JSON-decoded. Returns null for every kind of failure. */
async function ghJson(
  root: string,
  args: string[],
  exec: PolicyExec,
): Promise<{ value: unknown } | { error: string }> {
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await exec('gh', args, { cwd: root, timeout: DISCOVERY_TIMEOUT_MS });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim().split('\n')[0] ?? '';
    return { error: stderr === '' ? `gh exited with ${result.exitCode}` : stderr };
  }
  try {
    return { value: JSON.parse(result.stdout) as unknown };
  } catch {
    return { error: 'gh returned unparseable JSON' };
  }
}

/** How many labels a single `gh label list` page returns. */
const LABEL_PAGE_SIZE = 200;

export interface LabelDiscovery {
  labels: LabelDefinition[];
  sources: PolicySource[];
}

/**
 * The labels that exist in the repository.
 *
 * A machine with no `gh`, no authentication or no network degrades to an empty
 * list and a single `unavailable` source — never to a warning, and never to a
 * failure: reading labels is an enrichment, not a prerequisite.
 */
export async function discoverLabels(
  root: string,
  exec: PolicyExec = defaultExec,
): Promise<LabelDiscovery> {
  const outcome = await ghJson(
    root,
    ['label', 'list', '--json', 'name,description,color', '--limit', String(LABEL_PAGE_SIZE)],
    exec,
  );

  if ('error' in outcome) {
    return {
      labels: [],
      sources: [
        { kind: 'labels', origin: 'gh', path: null, status: 'unavailable', detail: outcome.error },
      ],
    };
  }

  const labels = parseLabels(outcome.value);
  return {
    labels,
    sources: [
      {
        kind: 'labels',
        origin: 'gh',
        path: null,
        status: 'found',
        detail: `${labels.length} label(s)`,
      },
    ],
  };
}

export interface IssueTypeDiscovery {
  types: string[];
  sources: PolicySource[];
}

/**
 * Issue Types of the organization owning the repository.
 *
 * Requires the owner, which comes from the git remote; a repository with no
 * remote simply has no organization to ask about, which is an ordinary state
 * and not an `unavailable` source.
 */
export async function discoverIssueTypes(
  root: string,
  owner: string | null,
  exec: PolicyExec = defaultExec,
): Promise<IssueTypeDiscovery> {
  if (owner === null || owner === '') {
    return { types: [], sources: [] };
  }

  const outcome = await ghJson(root, ['api', `orgs/${owner}/issue-types`], exec);
  if ('error' in outcome) {
    return {
      types: [],
      sources: [
        {
          kind: 'issue-types',
          origin: 'gh',
          path: null,
          // A personal account (404) and a plan without Issue Types (403) are
          // the common answers here, so the detail carries what gh said.
          status: 'unavailable',
          detail: outcome.error,
        },
      ],
    };
  }

  const types = parseIssueTypes(outcome.value);
  return {
    types,
    sources: [
      {
        kind: 'issue-types',
        origin: 'gh',
        path: null,
        status: 'found',
        detail: `${types.length} type(s)`,
      },
    ],
  };
}

/**
 * The `issueTemplates` connection, as one GraphQL document.
 *
 * Owner and repository travel as GraphQL variables rather than being spliced
 * into the query text: they come from a git remote, which is user-controlled
 * input, and a query built by concatenation is a query someone can rewrite.
 */
const ORGANIZATION_TEMPLATES_QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    issueTemplates{
      name
      title
      about
      filename
      body
      assignees(first:10){nodes{login}}
      labels(first:20){nodes{name}}
    }
  }
}`;

/**
 * The organization's `.github` repository, read as a tree.
 *
 * `issueTemplates` above only ever returns **markdown** templates: GitHub does
 * not expose organization-level Issue *Forms* through it, and a repository whose
 * organization publishes `.yml` forms therefore looks like a repository with no
 * templates at all. Reading the tree of the org's `.github` repository is the
 * only way to see them.
 *
 * One round-trip for names *and* contents, which is why it is a tree query
 * rather than the contents endpoint (a directory listing there carries no file
 * bodies, costing one call per template).
 */
const ORGANIZATION_FORMS_QUERY = `query($owner:String!){
  repository(owner:$owner,name:".github"){
    object(expression:"HEAD:.github/ISSUE_TEMPLATE"){
      ... on Tree {
        entries { name type object { ... on Blob { text } } }
      }
    }
  }
}`;

/**
 * Issue Forms published by the organization's `.github` repository.
 *
 * Answers an empty list for every ordinary case — no organization, no `.github`
 * repository, no `ISSUE_TEMPLATE` directory — so it is only ever an enrichment.
 */
export async function discoverOrganizationForms(
  root: string,
  owner: string | null,
  exec: PolicyExec = defaultExec,
): Promise<IssueTemplateDiscovery> {
  if (owner === null || owner === '') {
    return { templates: [], sources: [] };
  }

  const outcome = await ghJson(
    root,
    ['api', 'graphql', '-f', `query=${ORGANIZATION_FORMS_QUERY}`, '-f', `owner=${owner}`],
    exec,
  );
  if ('error' in outcome) {
    return {
      templates: [],
      sources: [
        {
          kind: 'issue-templates',
          origin: 'gh',
          path: null,
          status: 'unavailable',
          detail: outcome.error,
        },
      ],
    };
  }

  const templates = parseOrganizationForms(outcome.value);
  if (templates.length === 0) {
    return { templates, sources: [] };
  }
  return {
    templates,
    sources: templates.map((template) => ({
      kind: 'issue-templates' as const,
      origin: 'gh' as const,
      path: null,
      status: 'found' as const,
      detail: `organization form "${template.path}"`,
    })),
  };
}

/**
 * Issue Templates served by GitHub, including the ones the organization's
 * `.github` repository provides.
 *
 * Only consulted when the local tree has none: that is precisely the case local
 * discovery cannot see, and consulting it otherwise would spend a round-trip to
 * re-learn what is already on disk.
 *
 * GraphQL, not REST: the REST API exposes no issue-template endpoint at all,
 * and the connection returns the bodies inline, so the organization defaults
 * cost a single round-trip instead of one listing plus one call per template.
 */
export async function discoverOrganizationTemplates(
  root: string,
  slug: { owner: string; repo: string } | null,
  exec: PolicyExec = defaultExec,
): Promise<IssueTemplateDiscovery> {
  if (slug === null) {
    return { templates: [], sources: [] };
  }

  const outcome = await ghJson(
    root,
    [
      'api',
      'graphql',
      '-f',
      `query=${ORGANIZATION_TEMPLATES_QUERY}`,
      '-f',
      `owner=${slug.owner}`,
      '-f',
      `name=${slug.repo}`,
    ],
    exec,
  );
  if ('error' in outcome) {
    return {
      templates: [],
      sources: [
        {
          kind: 'issue-templates',
          origin: 'gh',
          path: null,
          status: 'unavailable',
          detail: outcome.error,
        },
      ],
    };
  }

  const templates = parseOrganizationTemplates(outcome.value);
  if (templates.length === 0) {
    return { templates, sources: [] };
  }
  return {
    templates,
    sources: templates.map((template) => ({
      kind: 'issue-templates' as const,
      origin: 'gh' as const,
      path: null,
      status: 'found' as const,
      detail: `organization default "${template.name}"`,
    })),
  };
}
