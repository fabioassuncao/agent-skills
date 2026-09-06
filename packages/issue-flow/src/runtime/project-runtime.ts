import { readFile } from 'node:fs/promises';
import { basename, join, resolve as resolvePath } from 'node:path';
import { loadWebConfig } from '../config.js';
import type { WebConfig } from '../schemas.js';
import { getProjectId } from '../storage/paths.js';

/**
 * The per-project runtime: everything a single project needs in order to be
 * served alongside the others, and nothing more.
 *
 * ADAPT of `createWebmuxRuntime()` (`backend/src/runtime.ts` @ d8c9d5f),
 * reduced on purpose. Upstream a runtime also owns git, tmux, worktrees,
 * reconciliation and per-project trackers; those arrive with phases 5, 6 and
 * 12 and would be a second, weaker implementation if written here first
 * (invariant 13). What this phase needs is the identity, the locator, the
 * derived prefix, the label and the resolved configuration — the four things
 * every consumer of the registry asks a project for.
 *
 * Configuration is *resolved from the repository*, never stored in the
 * registry (§47.6): `.issue-flow.json` stays inside the project, which is what
 * lets a project be moved, cloned or edited without the registry going stale.
 */

export interface ProjectRuntimeConfig {
  /** Display label. Cosmetic — the identity is `projectId`. */
  name: string;
  /** Web settings resolved for this project, not for the server's own cwd. */
  web: WebConfig;
}

export interface ProjectRuntime {
  /** `projectIdFromRemote()` — stable across moves and clones. */
  projectId: string;
  /** Absolute repository root. */
  root: string;
  /** URL-path prefix, derived per process and never persisted. */
  prefix: string;
  config: ProjectRuntimeConfig;
}

/** The minimum the manager needs to label and address a runtime. */
export interface ProjectRuntimeLike {
  projectId: string;
  config: { name: string };
}

export interface CreateProjectRuntimeOptions {
  projectDir: string;
  prefix: string;
  /** The single server port every project shares. */
  port: number;
}

/**
 * Read a human label for the project.
 *
 * `package.json` first because it is the name the developer already chose, the
 * directory basename otherwise. Both are advisory: a project with neither is
 * still perfectly serveable, so nothing here may throw.
 */
export async function resolveProjectName(root: string): Promise<string> {
  try {
    const raw = await readFile(join(root, 'package.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const name = (parsed as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim() !== '') return name.trim();
    }
  } catch {
    // Not a Node project, unreadable, or invalid JSON — the basename is fine.
  }
  return basename(root);
}

/** Materialize the runtime of one project. */
export async function createProjectRuntime(
  options: CreateProjectRuntimeOptions,
): Promise<ProjectRuntime> {
  const root = resolvePath(options.projectDir);
  const [projectId, name, web] = await Promise.all([
    getProjectId(root),
    resolveProjectName(root),
    // `projectRoot` is passed explicitly: without it the loader would read the
    // `.issue-flow.json` of whatever directory the *server* was started from,
    // which is precisely the bug a multi-project server invites.
    loadWebConfig({ projectRoot: root }),
  ]);

  return { projectId, root, prefix: options.prefix, config: { name, web } };
}
