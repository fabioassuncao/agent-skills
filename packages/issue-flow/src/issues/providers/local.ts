import { constants } from 'node:fs';
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ZodError } from 'zod';
import { isoNow } from '../../core/state-manager.js';
import { issueMetadataSchema } from '../../schemas.js';
import type { IssuePaths } from '../../storage/paths.js';
import { resolveIssuePaths, resolveProjectPaths } from '../../storage/resolve.js';
import { writeFileAtomic } from '../../utils/fs.js';
import { getProjectRoot } from '../../utils/git.js';
import { run } from '../../utils/shell.js';
import { hashIssueContent } from '../hash.js';
import { parseIssueMarkdown } from '../markdown.js';
import type { IssueProvider } from '../provider.js';
import type { Issue, IssueDraft, IssueMetadata } from '../types.js';

export { parseIssueMarkdown } from '../markdown.js';

/** Timeout for the optional remote probes done while allocating an identifier. */
const REMOTE_PROBE_TIMEOUT_MS = 10_000;

function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * True when `dir` already is a writable directory, or does not exist yet but
 * would be created successfully by `mkdir(dir, { recursive: true })` — i.e.
 * its nearest existing ancestor is a writable directory.
 *
 * Never mutates the filesystem: `isAvailable()` only needs to answer "could
 * this work", which must not leave a `~/.issue-flow/projects/<id>/` directory
 * behind for a project that ends up never using local issues (every other
 * source is queried on every resolution, so this runs far more often than the
 * provider is actually chosen).
 */
async function isWritableDirectory(dir: string): Promise<boolean> {
  let current = dir;
  for (;;) {
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(current);
    } catch (err: unknown) {
      if (!isNotFound(err)) return false;
      const parent = dirname(current);
      if (parent === current) return false; // reached the filesystem root
      current = parent;
      continue;
    }
    if (!stats.isDirectory()) return false;
    try {
      await access(current, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Identifiers become path segments, so anything that could escape the issues
 * directory is rejected before it reaches `join`.
 */
function normalizeId(id: string): string {
  const normalized = id.trim().replace(/^#/, '');
  if (normalized.length === 0) {
    throw new Error('Local issue identifier cannot be empty');
  }
  if (/[/\\]/.test(normalized) || normalized === '.' || normalized === '..') {
    throw new Error(`Invalid local issue identifier: '${id}'`);
  }
  return normalized;
}

function toNumber(id: string): number | null {
  return /^\d+$/.test(id) ? Number.parseInt(id, 10) : null;
}

function renderIssueMarkdown(title: string, body: string): string {
  return `# ${title}\n\n${body.trim()}\n`;
}

/**
 * Issue provider backed by plain files in the project's resolved artifact
 * store (global by default, workspace-local after explicit opt-in).
 *
 * Enables the whole pipeline without any network access: no gh, no remote, no
 * authentication. `issue.md` is the source of truth for the content and
 * `metadata.json` for everything else; the content hash is always recomputed
 * from the file so a hand-edited issue.md is never reported as unchanged.
 *
 * Every path goes through `resolveIssuePaths()`, exactly like the pipeline
 * commands.
 */
export class LocalFileIssueProvider implements IssueProvider {
  readonly name = 'local' as const;

  private readonly configuredRoot?: string;
  private cachedRoot?: string;

  /**
   * @param projectRoot Repository the issues belong to. It is no longer the
   * literal parent of an `issues/` directory: it is the root from which project
   * identity and the active artifact store are resolved.
   */
  constructor(projectRoot?: string) {
    this.configuredRoot = projectRoot;
  }

  /**
   * True whenever the project's resolved storage directory already is — or
   * could be — a writable directory. Never mutates the filesystem, never
   * throws.
   *
   * A brand new project has no directory of its own until something writes, so
   * "does it already exist" would report the provider as unavailable exactly
   * when it is about to create the very first issue — `isWritableDirectory`
   * walks up to the nearest existing ancestor instead of requiring the leaf to
   * be there already.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const { projectDir } = await resolveProjectPaths({ projectRoot: await this.root() });
      return await isWritableDirectory(projectDir);
    } catch {
      return false;
    }
  }

  async get(id: string): Promise<Issue | null> {
    const issueId = normalizeId(id);
    const markdownPath = await this.issueFile(issueId);

    let raw: string;
    try {
      raw = await readFile(markdownPath, 'utf-8');
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }

    const { title: headingTitle, body } = parseIssueMarkdown(raw);
    const metadata = await this.readMetadata(issueId);
    const title = headingTitle || metadata?.title || '';

    if (metadata) {
      return {
        id: metadata.id,
        number: metadata.number,
        title,
        body,
        labels: metadata.labels,
        state: metadata.state,
        source: 'local',
        remoteRef: metadata.remote?.ref ?? null,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        contentHash: hashIssueContent(title, body),
        raw: metadata,
      };
    }

    // metadata.json is optional: an issue.md dropped in by hand still works,
    // with timestamps taken from the file itself.
    const stats = await stat(markdownPath);
    return {
      id: issueId,
      number: toNumber(issueId),
      title,
      body,
      labels: [],
      state: 'open',
      source: 'local',
      remoteRef: null,
      createdAt: stats.birthtime.toISOString(),
      updatedAt: stats.mtime.toISOString(),
      contentHash: hashIssueContent(title, body),
    };
  }

  async create(draft: IssueDraft, options?: { localOnly?: boolean }): Promise<Issue> {
    // An explicit id is how a mirror keeps the identifier of the Issue it
    // mirrors: allocating a fresh one would make `issue-flow run <n>` see two
    // unrelated Issues instead of one demand in two places.
    const id =
      draft.id === undefined
        ? String(await this.allocateNumber(options?.localOnly))
        : normalizeId(draft.id);
    const paths = await this.paths(id);

    await mkdir(paths.issueDir, { recursive: true });

    // Exclusive create (the 'wx' flag, O_EXCL under the hood) instead of a
    // check-then-write: two concurrent `create()` calls racing the same id
    // would both pass a plain existence check before either writes, and the
    // second would then silently overwrite the first through the atomic
    // temp+rename writer. The OS now rejects the loser instead.
    try {
      await writeFile(paths.issueFile, renderIssueMarkdown(draft.title, draft.body), {
        encoding: 'utf-8',
        flag: 'wx',
      });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(
          `Local issue '${id}' already exists at ${paths.issueFile}. ` +
            'Remove it or pick another identifier before creating a new Issue.',
        );
      }
      throw err;
    }

    const timestamp = isoNow();
    const metadata: IssueMetadata = {
      schemaVersion: 1,
      id,
      number: toNumber(id),
      source: 'local',
      title: draft.title,
      labels: draft.labels,
      state: 'open',
      createdAt: timestamp,
      updatedAt: timestamp,
      contentHash: hashIssueContent(draft.title, draft.body),
      ...(draft.remote ? { remote: draft.remote } : {}),
    };

    await this.writeMetadata(id, metadata);

    return {
      id,
      number: metadata.number,
      title: draft.title,
      body: draft.body.trim(),
      labels: draft.labels,
      state: 'open',
      source: 'local',
      remoteRef: draft.remote?.ref ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      contentHash: metadata.contentHash,
      raw: metadata,
    };
  }

  async close(id: string): Promise<void> {
    const issue = await this.get(id);
    if (!issue) {
      const issueDir = (await this.paths(normalizeId(id))).issueDir;
      throw new Error(`Local issue '${normalizeId(id)}' not found at ${issueDir}`);
    }

    const issueId = normalizeId(id);
    const existing = await this.readMetadata(issueId);

    await this.writeMetadata(issueId, {
      schemaVersion: 1,
      id: issue.id,
      number: issue.number,
      source: existing?.source ?? 'local',
      title: issue.title,
      labels: issue.labels,
      state: 'closed',
      createdAt: issue.createdAt,
      updatedAt: isoNow(),
      contentHash: issue.contentHash,
      ...(existing?.remote ? { remote: existing.remote } : {}),
    });
  }

  /**
   * Next free identifier: above every local number and, when GitHub answers,
   * above every remote one too. Sharing a numbering space with the remote is
   * what makes a naive `localMax + 1` collide the moment someone opens an Issue
   * on GitHub.
   */
  async allocateNumber(localOnly = false): Promise<number> {
    const [local, remote] = await Promise.all([
      this.highestLocalNumber(),
      localOnly ? Promise.resolve(0) : highestRemoteNumber(),
    ]);
    return Math.max(local, remote) + 1;
  }

  private async root(): Promise<string> {
    if (this.configuredRoot !== undefined) return this.configuredRoot;
    this.cachedRoot ??= await getProjectRoot();
    return this.cachedRoot;
  }

  /** Every artifact of one issue, from the same resolver the pipeline uses. */
  private async paths(id: string): Promise<IssuePaths> {
    return resolveIssuePaths(id, { projectRoot: await this.root() });
  }

  private async issueFile(id: string): Promise<string> {
    return (await this.paths(id)).issueFile;
  }

  private async metadataFile(id: string): Promise<string> {
    return (await this.paths(id)).metadataFile;
  }

  /** Parsed metadata.json, or `null` when the file is absent. */
  private async readMetadata(id: string): Promise<IssueMetadata | null> {
    const path = await this.metadataFile(id);

    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err: unknown) {
      throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`);
    }

    try {
      return issueMetadataSchema.parse(parsed);
    } catch (err: unknown) {
      if (err instanceof ZodError) {
        const details = err.issues
          .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('\n');
        throw new Error(`Invalid issue metadata at ${path}:\n${details}`);
      }
      throw err;
    }
  }

  private async writeMetadata(id: string, metadata: IssueMetadata): Promise<void> {
    await writeFileAtomic(await this.metadataFile(id), `${JSON.stringify(metadata, null, 2)}\n`);
  }

  /**
   * Highest number across every `<issuesDir>/<id>/metadata.json` and numeric
   * directory name.
   *
   * Resolving `issuesDir` keeps allocation scoped to the selected store.
   */
  private async highestLocalNumber(): Promise<number> {
    const { issuesDir: dir } = await resolveProjectPaths({ projectRoot: await this.root() });

    let entries: string[];
    try {
      entries = (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (err: unknown) {
      if (isNotFound(err)) return 0;
      throw err;
    }

    const numbers = await Promise.all(
      entries.map(async (name) => {
        const fromName = toNumber(name) ?? 0;
        // A directory whose metadata is unreadable still occupies its number.
        const fromMetadata = await this.readMetadata(name)
          .then((metadata) => metadata?.number ?? 0)
          .catch(() => 0);
        return Math.max(fromName, fromMetadata);
      }),
    );

    return numbers.reduce((max, value) => Math.max(max, value), 0);
  }
}

/** How many of the most-recently-created issues/PRs to inspect per probe. */
const REMOTE_PROBE_SAMPLE_SIZE = 20;

/**
 * Highest number already taken on GitHub, or 0 when the remote is unreachable.
 *
 * Issues and pull requests share one counter, so both are probed: allocating
 * above the newest Issue alone would still collide with an open PR. Every
 * failure degrades to 0 — being offline must not block local creation.
 *
 * `gh ... list` defaults to sorting by creation date descending, which lines
 * up with number order in the overwhelming majority of repos — but that sort
 * is an implementation detail, not a contract. Rather than trust that the
 * single most-recent entry is also the highest-numbered one, a small sample
 * is fetched and the max is taken across it, which also tolerates the rare
 * case of a transferred issue whose creation date and number disagree.
 */
async function highestRemoteNumber(): Promise<number> {
  const probes = [
    ['issue', 'list'],
    ['pr', 'list'],
  ];

  const results = await Promise.all(
    probes.map(async (args) => {
      try {
        const result = await run(
          'gh',
          [
            ...args,
            '--state',
            'all',
            '--limit',
            String(REMOTE_PROBE_SAMPLE_SIZE),
            '--json',
            'number',
          ],
          { timeout: REMOTE_PROBE_TIMEOUT_MS },
        );
        if (result.exitCode !== 0) return 0;

        const parsed = JSON.parse(result.stdout);
        if (!Array.isArray(parsed)) return 0;
        return parsed.reduce((max: number, entry: unknown) => {
          const n = (entry as { number?: unknown } | null)?.number;
          return typeof n === 'number' ? Math.max(max, n) : max;
        }, 0);
      } catch {
        return 0;
      }
    }),
  );

  return results.reduce((max, value) => Math.max(max, value), 0);
}

/** Shared instance resolving the project root lazily via git. */
export const localFileIssueProvider = new LocalFileIssueProvider();
