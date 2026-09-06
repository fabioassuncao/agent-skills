import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { run } from '../../utils/shell.js';

/**
 * Git operations a worktree needs.
 *
 * Ported from WebMux `backend/src/adapters/git.ts` @ d8c9d5f (483 LOC). The
 * Issue Flow had no worktree implementation at all, so §45.1-E makes the
 * upstream canonical for the operations themselves — but §45.1-F keeps Issue
 * Flow canonical for *how* a command is run. The combination §45.2 spells out
 * is what this file is: the upstream's operations, entering through Issue
 * Flow's `run()` chokepoint so they inherit the destructive-git allowlist and
 * the retry policy that `Bun.spawnSync` never had.
 *
 * That is also why every method is async here and synchronous upstream: the
 * chokepoint is async, and having a second, synchronous shell path would be
 * exactly the duplicated responsibility the absorption forbids.
 */

export interface GitWorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  bare: boolean;
}

export type CreateWorktreeMode = 'new' | 'existing';

interface BaseCreateWorktreeOptions {
  repoRoot: string;
  worktreePath: string;
  branch: string;
}

export interface CreateNewWorktreeOptions extends BaseCreateWorktreeOptions {
  mode: 'new';
  baseBranch?: string;
}

export interface CreateExistingWorktreeOptions extends BaseCreateWorktreeOptions {
  mode: 'existing';
  /** Set when the branch exists only on the remote. */
  startPoint?: string;
}

export type CreateWorktreeOptions = CreateNewWorktreeOptions | CreateExistingWorktreeOptions;

export interface RemoveWorktreeOptions {
  repoRoot: string;
  worktreePath: string;
  force?: boolean;
}

export interface MergeBranchOptions {
  repoRoot: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface WorktreeStatus {
  dirty: boolean;
  aheadCount: number;
  currentCommit: string | null;
}

export interface UnpushedCommit {
  hash: string;
  message: string;
}

export type GitCommandResult = { ok: true; stdout: string } | { ok: false; stderr: string };

export interface GitWorktreeGateway {
  resolveRepoRoot(dir: string): Promise<string | null>;
  resolveWorktreeRoot(cwd: string): Promise<string>;
  resolveWorktreeGitDir(cwd: string): Promise<string>;
  listWorktrees(cwd: string): Promise<GitWorktreeEntry[]>;
  listLiveWorktrees(cwd: string): Promise<GitWorktreeEntry[]>;
  listLocalBranches(cwd: string): Promise<string[]>;
  listRemoteBranches(cwd: string): Promise<string[]>;
  readWorktreeStatus(cwd: string): Promise<WorktreeStatus>;
  readStatus(cwd: string): Promise<string>;
  createWorktree(options: CreateWorktreeOptions): Promise<void>;
  removeWorktree(options: RemoveWorktreeOptions): Promise<void>;
  deleteBranch(repoRoot: string, branch: string, force?: boolean): Promise<void>;
  mergeBranch(options: MergeBranchOptions): Promise<void>;
  currentBranch(repoRoot: string): Promise<string>;
  readDiff(cwd: string): Promise<string>;
  listUnpushedCommits(cwd: string): Promise<UnpushedCommit[]>;
  fetchBranch(repoRoot: string, remote: string, branch: string): Promise<GitCommandResult>;
  fastForwardMerge(repoRoot: string, ref: string): Promise<GitCommandResult>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Non-throwing git, through the chokepoint. Diagnostics are off: the caller decides. */
export async function tryGit(args: string[], cwd: string): Promise<GitCommandResult> {
  try {
    const result = await run('git', args, { cwd, diagnostics: false });
    if (result.exitCode !== 0) {
      return { ok: false, stderr: result.stderr.trim() || `exit ${result.exitCode}` };
    }
    return { ok: true, stdout: result.stdout.trim() };
  } catch (error) {
    // execa throws synchronously when cwd does not exist (posix_spawn ENOENT).
    // The upstream carries the same guard, and the reason is the same: a
    // worktree whose directory was deleted underneath us is an ordinary state,
    // not a crash.
    return { ok: false, stderr: `spawn error (cwd=${cwd}): ${errorMessage(error)}` };
  }
}

/** Throwing git, with the failing command in the message. */
export async function git(args: string[], cwd: string): Promise<string> {
  const result = await tryGit(args, cwd);
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * Pure, and ported line for line: the format is a stanza per worktree
 * terminated by a blank line, and the trailing stanza has no terminator — which
 * is why `flush()` runs once more after the loop.
 */
export function parseGitWorktreePorcelain(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;

  const flush = (): void => {
    if (current?.path) entries.push(current);
    current = null;
  };

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) {
      flush();
      continue;
    }

    if (line.startsWith('worktree ')) {
      flush();
      current = {
        path: line.slice('worktree '.length),
        branch: null,
        head: null,
        detached: false,
        bare: false,
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      continue;
    }

    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
      continue;
    }

    if (line === 'detached') {
      current.detached = true;
      continue;
    }

    if (line === 'bare') {
      current.bare = true;
    }
  }

  flush();
  return entries;
}

export async function worktreeEntryPathExists(entry: GitWorktreeEntry): Promise<boolean> {
  try {
    return (await stat(entry.path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Drop entries whose directory is gone.
 *
 * git keeps an administrative record of a worktree whose directory was deleted
 * by hand until someone prunes it, so `worktree list` alone is not the same
 * question as "which worktrees exist". Every caller here wants the second one.
 */
export async function filterLiveWorktreeEntries(
  entries: GitWorktreeEntry[],
): Promise<GitWorktreeEntry[]> {
  const alive = await Promise.all(entries.map(worktreeEntryPathExists));
  return entries.filter((_entry, index) => alive[index] === true);
}

function isRegisteredWorktree(entries: GitWorktreeEntry[], worktreePath: string): boolean {
  const resolvedPath = resolve(worktreePath);
  return entries.some((entry) => resolve(entry.path) === resolvedPath);
}

async function currentCheckoutRef(cwd: string): Promise<{ ref: string; branch: string | null }> {
  const symbolicRef = await tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  if (symbolicRef.ok && symbolicRef.stdout.length > 0) {
    return { ref: symbolicRef.stdout, branch: symbolicRef.stdout };
  }
  // Detached HEAD: the commit is the only thing to restore to.
  return { ref: await git(['rev-parse', '--verify', 'HEAD'], cwd), branch: null };
}

/**
 * Repository root for a directory.
 *
 * When `dir` is itself inside a repository, that is the answer. When it is not,
 * it may be a worktree *container* — the directory holding several worktrees —
 * and the root is resolved from the first child that is a repository. Returns
 * `null` when neither holds.
 */
export async function resolveRepoRoot(dir: string): Promise<string | null> {
  const direct = await tryGit(['rev-parse', '--show-toplevel'], dir);
  if (direct.ok) return resolve(dir, direct.stdout);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const child = join(dir, entry);
    try {
      if (!(await stat(child)).isDirectory()) continue;
    } catch {
      continue;
    }
    const childResult = await tryGit(['rev-parse', '--show-toplevel'], child);
    if (childResult.ok) return resolve(child, childResult.stdout);
  }
  return null;
}

export interface RemoveWorktreeDeps {
  tryGit?: (args: string[], cwd: string) => Promise<GitCommandResult>;
  listWorktrees?: (cwd: string) => Promise<GitWorktreeEntry[]>;
  removeDirectory?: (path: string) => Promise<void>;
}

/**
 * Remove a worktree, falling back to deleting the directory.
 *
 * `git worktree remove` refuses in cases that leave the directory behind while
 * git has already forgotten it — or never knew it. The fallback only runs once
 * git confirms the path is **not** a registered worktree any more: deleting a
 * directory git still considers live would corrupt the repository's view of it.
 * That check is the reason this is not simply "try, then rm -rf".
 */
export async function removeGitWorktree(
  options: RemoveWorktreeOptions,
  deps: RemoveWorktreeDeps = {},
): Promise<void> {
  const args = ['worktree', 'remove'];
  if (options.force) args.push('--force');
  args.push(options.worktreePath);

  const result = await (deps.tryGit ?? tryGit)(args, options.repoRoot);
  if (result.ok) return;

  const failure = `git ${args.join(' ')} failed: ${result.stderr || 'exit 1'}`;
  const remaining = await (deps.listWorktrees ?? listGitWorktrees)(options.repoRoot);
  if (isRegisteredWorktree(remaining, options.worktreePath)) throw new Error(failure);

  try {
    await (deps.removeDirectory ?? ((path: string) => rm(path, { recursive: true, force: true })))(
      options.worktreePath,
    );
  } catch (error) {
    throw new Error(`${failure}; cleanup failed: ${errorMessage(error)}`);
  }
}

export async function listGitWorktrees(cwd: string): Promise<GitWorktreeEntry[]> {
  return parseGitWorktreePorcelain(await git(['worktree', 'list', '--porcelain'], cwd));
}

function nonEmptyLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function listLocalGitBranches(cwd: string): Promise<string[]> {
  return nonEmptyLines(await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], cwd));
}

export async function listRemoteGitBranches(cwd: string): Promise<string[]> {
  // A failed fetch is not a failed listing: offline, the cached refs are still
  // the best answer available, and refusing to list would block worktree
  // creation from an existing remote branch for no reason.
  await tryGit(['fetch', '--prune', 'origin'], cwd);
  const output = await git(
    ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'],
    cwd,
  );
  return (
    nonEmptyLines(output)
      .map((line) => line.replace(/^origin\//, ''))
      // Defensive: some repositories expose a bare symbolic `origin` ref
      // alongside `origin/*`, and neither is a branch anyone can check out.
      .filter((name) => name !== 'HEAD' && name !== 'origin')
  );
}

export async function readGitWorktreeStatus(cwd: string): Promise<WorktreeStatus> {
  const dirtyOutput = await git(['status', '--porcelain'], cwd);
  const commit = await tryGit(['rev-parse', 'HEAD'], cwd);
  let ahead = await tryGit(['rev-list', '--count', '@{upstream}..HEAD'], cwd);
  if (!ahead.ok) {
    // No upstream configured. Counting against every origin ref may slightly
    // over-count on a repository with many branches, but it is a truthful
    // "commits nobody has" where the precise question has no answer.
    ahead = await tryGit(['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'], cwd);
  }

  return {
    dirty: dirtyOutput.length > 0,
    aheadCount: ahead.ok ? Number.parseInt(ahead.stdout, 10) || 0 : 0,
    currentCommit: commit.ok && commit.stdout.length > 0 ? commit.stdout : null,
  };
}

/** Build the argv of `git worktree add`. Pure, so the characterization test can compare it. */
export function worktreeAddArgs(options: CreateWorktreeOptions): string[] {
  const args = ['worktree', 'add'];
  if (options.mode === 'new') {
    args.push('-b', options.branch, options.worktreePath);
    if (options.baseBranch) args.push(options.baseBranch);
    return args;
  }
  if (options.startPoint) {
    args.push('-b', options.branch, options.worktreePath, options.startPoint);
    return args;
  }
  args.push(options.worktreePath, options.branch);
  return args;
}

export function createGitWorktreeGateway(): GitWorktreeGateway {
  return {
    resolveRepoRoot,
    resolveWorktreeRoot: async (cwd) =>
      resolve(cwd, await git(['rev-parse', '--show-toplevel'], cwd)),
    resolveWorktreeGitDir: async (cwd) => resolve(cwd, await git(['rev-parse', '--git-dir'], cwd)),
    listWorktrees: listGitWorktrees,
    listLiveWorktrees: async (cwd) => filterLiveWorktreeEntries(await listGitWorktrees(cwd)),
    listLocalBranches: listLocalGitBranches,
    listRemoteBranches: listRemoteGitBranches,
    readWorktreeStatus: readGitWorktreeStatus,
    readStatus: (cwd) => git(['status', '--short', '--untracked-files=all'], cwd),
    createWorktree: async (options) => {
      await git(worktreeAddArgs(options), options.repoRoot);
    },
    removeWorktree: (options) => removeGitWorktree(options),
    deleteBranch: async (repoRoot, branch, force = false) => {
      await git(['branch', force ? '-D' : '-d', branch], repoRoot);
    },

    /**
     * Merge one branch into another and put the repository back where it was.
     *
     * The restore is the point. A merge runs on the target branch, so the
     * repository has to be moved there and moved back — and it has to be moved
     * back **even when the merge failed**, which is the case a naive
     * implementation leaves the user checked out somewhere they never asked to
     * be. Cleanup failures are appended to the original cause rather than
     * replacing it: the merge error is what the caller needs to read first.
     */
    mergeBranch: async (options) => {
      const current = await currentCheckoutRef(options.repoRoot);
      const shouldRestore = current.branch !== options.targetBranch;
      if (shouldRestore) await git(['checkout', options.targetBranch], options.repoRoot);

      let mergeError: string | null = null;
      const cleanupErrors: string[] = [];

      try {
        await git(['merge', '--no-ff', '--no-edit', options.sourceBranch], options.repoRoot);
      } catch (error) {
        mergeError = errorMessage(error);
        const abort = await tryGit(['merge', '--abort'], options.repoRoot);
        // "MERGE_HEAD missing" means the merge never started — nothing to abort
        // and nothing worth reporting on top of the real failure.
        if (!abort.ok && abort.stderr.length > 0 && !abort.stderr.includes('MERGE_HEAD missing')) {
          cleanupErrors.push(`merge abort failed: ${abort.stderr}`);
        }
      }

      if (shouldRestore) {
        const restore = await tryGit(['checkout', current.ref], options.repoRoot);
        if (!restore.ok) cleanupErrors.push(`restore checkout failed: ${restore.stderr}`);
      }

      if (mergeError !== null) {
        const suffix = cleanupErrors.length > 0 ? `; ${cleanupErrors.join('; ')}` : '';
        throw new Error(`${mergeError}${suffix}`);
      }
      if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join('; '));
    },

    currentBranch: (repoRoot) => git(['branch', '--show-current'], repoRoot),
    readDiff: async (cwd) => {
      const result = await tryGit(['diff', 'HEAD', '--no-color'], cwd);
      return result.ok ? result.stdout : '';
    },
    listUnpushedCommits: async (cwd) => {
      let result = await tryGit(['log', '--oneline', '@{upstream}..HEAD'], cwd);
      if (!result.ok) {
        // Same trade-off as readGitWorktreeStatus's ahead count.
        result = await tryGit(['log', '--oneline', 'HEAD', '--not', '--remotes=origin'], cwd);
      }
      if (!result.ok || result.stdout === '') return [];
      return result.stdout
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => {
          const spaceIndex = line.indexOf(' ');
          return { hash: line.slice(0, spaceIndex), message: line.slice(spaceIndex + 1) };
        });
    },
    fetchBranch: (repoRoot, remote, branch) => tryGit(['fetch', remote, branch], repoRoot),
    fastForwardMerge: (repoRoot, ref) => tryGit(['merge', '--ff-only', ref], repoRoot),
  };
}
