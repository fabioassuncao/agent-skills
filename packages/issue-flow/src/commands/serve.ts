import { resolveAgentSessionDeps } from '../agents/session/context.js';
import { loadGlobalConfig } from '../config/sources.js';
import { loadWebConfig } from '../config.js';
import {
  defaultProjectInitDeps,
  ProjectInitTracker,
  runProjectInit,
} from '../runtime/project-init.js';
import { ProjectManager } from '../runtime/project-manager.js';
import type { ProjectRuntimeLike } from '../runtime/project-runtime.js';
import type { WebConfig } from '../schemas.js';
import { createProjectRegistry } from '../storage/projects/registry.js';
import { resolveProjectPaths } from '../storage/resolve.js';
import { printWarning } from '../ui/logger.js';
import { getProjectRootOf, isGitRepository } from '../utils/git.js';
import { ensureSingleWebServer } from '../web/lock.js';
import { type ProjectsApiDeps, repositoryNeedsSetup } from '../web/projects-api.js';
import { watchSessionDirectory } from '../web/session-directory.js';
import type { SessionsApiDeps, SessionsApiProject } from '../web/sessions-api.js';

/**
 * `issue-flow serve` — one permanent monitor for every curated project (§47.4).
 *
 * It is the same process `issue-flow web serve` already was, and it still owns
 * the same `web.lock`: one server per machine, claimed after a successful bind.
 * What is new is what it serves — the curated project list rather than only
 * whatever happened to be executing.
 *
 * The boot order is the upstream's, and each step is where it is for a reason:
 *
 * 1. bind first, so the dashboard answers while the projects are still loading;
 * 2. load the curated projects, skipping (never aborting on) the ones that fail;
 * 3. auto-add the current repository *ephemerally* — served now, not written,
 *    so no other server on this machine inherits it on its next restart;
 * 4. light loops for every project, heavy loops only for the active one.
 *
 * Steps 4's loops are no-ops today: reconciliation, worktree GC and the PR/CI
 * poll arrive with later phases, and writing weaker versions of them here would
 * be the duplication the absorption exists to avoid.
 */

/** Extra project roots for a service unit, which has no useful cwd. */
export const PROJECT_DIR_ENV = 'ISSUE_FLOW_PROJECT_DIR';

export interface RunServeOptions {
  port?: number;
  host?: string;
  refresh?: number;
  /** Additional repositories to serve for this process only. Repeatable. */
  project?: string[];
  /** Environment source. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Working directory considered for the auto-add. Defaults to process.cwd(). */
  cwd?: string;
}

/**
 * Read `ISSUE_FLOW_PROJECT_DIR`.
 *
 * ADAPT of `WEBMUX_PROJECT_DIR`. A `systemd` unit or a launch agent starts in
 * `/`, so "the repository I am standing in" is not a question it can answer —
 * this is how such a deployment names its projects. Several are accepted,
 * separated by the platform's path separator, because one variable per project
 * would not survive contact with a unit file.
 */
export function projectDirsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[PROJECT_DIR_ENV];
  if (raw === undefined) return [];
  return raw
    .split(/[:;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export async function runServe(options: RunServeOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  // Built conditionally, not `{ port: options.port, … }`: loadWebConfig()
  // spreads this over the lower-precedence layers, and an explicit `undefined`
  // would overwrite an env/.issue-flow.json setting instead of falling through.
  const cli: Partial<WebConfig> = {};
  if (options.port !== undefined) cli.port = options.port;
  if (options.host !== undefined) cli.host = options.host;
  if (options.refresh !== undefined) cli.refreshSeconds = options.refresh;
  const webConfig = await loadWebConfig({ cli });

  let storageDriver = (await loadGlobalConfig()).storage?.driver ?? 'sqlite';
  try {
    storageDriver = (await resolveProjectPaths()).storageDriver;
  } catch {
    // The machine-wide monitor stays usable outside a repository.
  }

  const registry = createProjectRegistry();
  const sessions = watchSessionDirectory({ storageDriver, registry });
  const tracker = new ProjectInitTracker();
  const manager = new ProjectManager({
    registry,
    port: webConfig.port,
    warn: printWarning,
  });

  const projects: ProjectsApiDeps = {
    manager,
    registry,
    tracker,
    // Adding a project reaches the filesystem, so it follows the same rule the
    // configuration writes do: loopback bindings only (ADR-10).
    writable: isLoopbackHost(webConfig.host),
    resolveRoot: getProjectRootOf,
    needsSetup: repositoryNeedsSetup,
    startSetup: (root) => {
      void runProjectInit(
        tracker,
        root,
        defaultProjectInitDeps(async (target) => {
          const project = await manager.add(target);
          return { prefix: project.prefix, name: project.entry.name };
        }),
        printWarning,
      );
    },
  };

  // The agent-session surface (§49). Its wiring is per project and expensive
  // to build — a worktree manager, a tmux gateway and a resolved profile map —
  // so it is built on first use and kept: a dashboard opening a session is not
  // a reason to re-read `.issue-flow.json` for every request.
  const sessionDepsCache = new Map<string, Promise<SessionsApiProject>>();
  const agentSessions: SessionsApiDeps = {
    // Opening a session starts a process on this machine and typing into one is
    // a remote shell, so it follows the rule the configuration and project
    // writes already follow: loopback bindings only (ADR-10).
    writable: isLoopbackHost(webConfig.host),
    resolveProject: async (projectId) => {
      // An unprefixed request names no project. With exactly one served, that
      // is not ambiguous and answering it is what keeps a single-project user
      // from having to learn that prefixes exist — the same fallback
      // `GET /api/status` already makes. With several, it genuinely is
      // ambiguous, and guessing would open a session in the wrong repository.
      const served =
        projectId === null
          ? manager.list().length === 1
            ? manager.list()[0]
            : null
          : manager.getById(projectId);
      if (served === undefined || served === null) return null;
      const cached = sessionDepsCache.get(served.entry.id);
      if (cached !== undefined) return cached;
      const built = resolveAgentSessionDeps({ projectRoot: served.entry.root }).then((context) => ({
        projectId: context.projectId,
        deps: context.deps,
      }));
      sessionDepsCache.set(served.entry.id, built);
      return built;
    },
  };

  const noop = (): void => {};
  const handle = await ensureSingleWebServer({
    sessions,
    projects,
    agentSessions,
    port: webConfig.port,
    host: webConfig.host,
    refreshSeconds: webConfig.refreshSeconds,
    unref: false,
    info: noop,
    warn: noop,
  });

  if (handle === null) {
    sessions.close();
    return 1;
  }

  if (handle.server === undefined) {
    // Another instance already owns the lock: nothing to serve here, so this
    // process exits instead of idling as a redundant detached server.
    sessions.close();
    return 0;
  }

  // Only now, with the socket bound: a slow project must not delay the moment
  // the dashboard starts answering.
  await loadProjects(manager, { cwd, env, projectDirs: options.project ?? [] });

  const originalClose = handle.close;
  handle.close = async () => {
    await originalClose();
    sessions.close();
  };

  return 0;
}

interface LoadProjectsInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  projectDirs: string[];
  /** Repository probe. Injected so the boot can be tested without real repos. */
  isRepository?: (path: string) => Promise<boolean>;
}

/** Steps 2 and 3 of the boot order, extracted so they can be tested alone. */
export async function loadProjects<R extends ProjectRuntimeLike>(
  manager: ProjectManager<R>,
  input: LoadProjectsInput,
): Promise<void> {
  await manager.loadPersisted();

  // `--project` and ISSUE_FLOW_PROJECT_DIR are served for this process only,
  // for the same reason the cwd is: naming a repository on one server's command
  // line must not enlist it into every other server on the machine.
  for (const dir of [...input.projectDirs, ...projectDirsFromEnv(input.env)]) {
    try {
      await manager.addEphemeral(dir);
    } catch (error: unknown) {
      printWarning(
        `Skipping project ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await autoAddCwd(manager, input.cwd, input.isRepository);
}

/**
 * Serve the repository the server was started in, if it is one.
 *
 * Ephemeral by construction (PORT of `autoAddCwd`): the project is served for
 * as long as this process lives and never enters the curated list, so no other
 * server on this machine reloads it. A repository that is already curated is
 * found by root and returned unchanged, so this never demotes anything.
 *
 * It does not follow that the database stays untouched: resolving the storage
 * of a repository has always adopted it (`storage/resolve.ts`), which is what
 * creates its `discovered` row. That row predates the registry and is the same
 * one a plain `issue-flow run` leaves behind — `ephemeral` is about curation,
 * not about whether the project has ever been seen.
 */
export async function autoAddCwd<R extends ProjectRuntimeLike>(
  manager: ProjectManager<R>,
  cwd: string,
  isRepository: (path: string) => Promise<boolean> = isGitRepository,
): Promise<void> {
  if (!(await isRepository(cwd))) return;
  try {
    await manager.addEphemeral(cwd);
  } catch (error: unknown) {
    printWarning(
      `Could not serve the current repository: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
