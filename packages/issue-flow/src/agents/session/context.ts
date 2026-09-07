import { randomUUID } from 'node:crypto';
import { loadRuntimeConfig } from '../../config/runtime.js';
import { resolveProfile, resolveProfileSystemPrompt } from '../../runtime/profiles.js';
import type { ServiceSpec } from '../../runtime/services.js';
import { createTmuxGateway } from '../../runtime/tmux/gateway.js';
import { createGitWorktreeGateway, type GitWorktreeGateway } from '../../runtime/worktree/git.js';
import { createWorktreeManager, type WorktreeManager } from '../../runtime/worktree/lifecycle.js';
import { getWorktreeMutationLockDir } from '../../runtime/worktree/lock.js';
import type { PlanRepositoryContext } from '../../storage/db/repository.js';
import { resolveProjectPaths } from '../../storage/resolve.js';
import { printWarning } from '../../ui/logger.js';
import { getBaseBranch, getProjectRootOf, localBranchExists } from '../../utils/git.js';
import { CodexAppServerClient } from './codex.js';
import type { AgentSessionDeps } from './open.js';

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
  worktrees: WorktreeManager;
  git: GitWorktreeGateway;
  /** Names accepted by profile-changing HTTP operations. */
  profileNames: readonly string[];
  profileConfigs: readonly { name: string; systemPrompt?: string }[];
  startupEnv: Readonly<Record<string, string>>;

  services: readonly ServiceSpec[];
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
  const systemPrompt = resolveProfileSystemPrompt(resolved.profile, runtime.startupEnv);
  const mainBranch = await getBaseBranch(projectRoot);
  const git = createGitWorktreeGateway();
  const worktreeLockDir = getWorktreeMutationLockDir(paths.projectDir);

  const worktrees = createWorktreeManager({
    projectRoot,
    storage,
    mainBranch,
    git,
    mutationLockDir: worktreeLockDir,
  });
  const deps: AgentSessionDeps = {
    projectId: paths.projectId,
    projectRoot,
    storage,
    worktrees,
    tmux: createTmuxGateway(),
    git,
    branchExists: (branch) => localBranchExists(branch, projectRoot),
    panes: resolved.profile.panes,
    profileName: resolved.name,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    worktreeLockDir,
    prepareConversation: async (provider, cwd, developerInstructions) => {
      if (provider === 'claude') return randomUUID();
      if (provider !== 'codex') return null;
      const client = new CodexAppServerClient({ clientName: 'issue-flow-session-open' });
      try {
        return (
          await client.threadStart({
            cwd,
            ...(developerInstructions === undefined ? {} : { developerInstructions }),
          })
        ).thread.id;
      } finally {
        client.close();
      }
    },
    ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
  };

  return {
    deps,
    projectId: paths.projectId,
    projectRoot,
    storage,
    profileName: resolved.name,
    mainBranch,
    worktrees,
    git,
    profileNames: Object.keys(runtime.profiles),
    profileConfigs: Object.entries(runtime.profiles).map(([name, profile]) => ({
      name,
      ...(profile.systemPrompt === undefined ? {} : { systemPrompt: profile.systemPrompt }),
    })),
    startupEnv: runtime.startupEnv,
    services: runtime.services,
  };
}
