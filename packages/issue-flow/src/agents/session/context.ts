import { loadRuntimeConfig } from '../../config/runtime.js';
import { resolveProfile } from '../../runtime/profiles.js';
import { createTmuxGateway } from '../../runtime/tmux/gateway.js';
import { createGitWorktreeGateway } from '../../runtime/worktree/git.js';
import { createWorktreeManager } from '../../runtime/worktree/lifecycle.js';
import type { PlanRepositoryContext } from '../../storage/db/repository.js';
import { resolveProjectPaths } from '../../storage/resolve.js';
import { printWarning } from '../../ui/logger.js';
import { getBaseBranch, getProjectRootOf, localBranchExists } from '../../utils/git.js';
import type { AgentSessionDeps } from './open.js';

/**
 * Everything `openAgentSession` needs, assembled from a repository on disk.
 *
 * It exists so the CLI and the HTTP surface open sessions through the **same**
 * wiring. Two entry points assembling their own worktree manager, tmux gateway
 * and profile lookup is how the two start disagreeing about which profile a
 * session used or which socket its window lives on — and §25 asks for one
 * implementation per responsibility, not one per caller.
 *
 * The storage context is the issue-agnostic shape `resolveProjectPaths` already
 * registers (`tasksPath: ''`, `issueId: ''`): a free session has no issue, and
 * inventing one to satisfy the type would put a phantom row in `issues`.
 */

export interface ResolveAgentSessionDepsOptions {
  /** Repository to open sessions in. Defaults to the current one. */
  projectRoot?: string;
  /** Runtime profile to open with. Falls back to the default, loudly. */
  profile?: string;
  /** Login shell for shell panes. Defaults to `$SHELL`. */
  shellPath?: string;
  warn?: (message: string) => void;
}

export interface ResolvedAgentSessionContext {
  deps: AgentSessionDeps;
  projectId: string;
  projectRoot: string;
  storage: PlanRepositoryContext;
  /** The profile actually resolved, which may not be the one asked for. */
  profileName: string;
  mainBranch: string;
}

export async function resolveAgentSessionDeps(
  options: ResolveAgentSessionDepsOptions = {},
): Promise<ResolvedAgentSessionContext> {
  const warn = options.warn ?? printWarning;
  const projectRoot = await getProjectRootOf(options.projectRoot ?? process.cwd());
  const paths = await resolveProjectPaths({ projectRoot });
  const storage: PlanRepositoryContext = {
    tasksPath: '',
    projectId: paths.projectId,
    issueId: '',
    projectRoot,
    databaseOptions: paths.databaseOptions,
  };

  const runtime = await loadRuntimeConfig({ projectRoot, warn });
  const resolved = resolveProfile(runtime.profiles, options.profile ?? runtime.profile, warn);
  const mainBranch = await getBaseBranch(projectRoot);
  const git = createGitWorktreeGateway();

  const deps: AgentSessionDeps = {
    projectId: paths.projectId,
    projectRoot,
    storage,
    worktrees: createWorktreeManager({ projectRoot, storage, mainBranch, git }),
    tmux: createTmuxGateway(),
    git,
    branchExists: (branch) => localBranchExists(branch, projectRoot),
    panes: resolved.profile.panes,
    profileName: resolved.name,
    ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
  };

  return {
    deps,
    projectId: paths.projectId,
    projectRoot,
    storage,
    profileName: resolved.name,
    mainBranch,
  };
}
