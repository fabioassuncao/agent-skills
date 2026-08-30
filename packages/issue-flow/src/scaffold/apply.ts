import { access, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { loadRepositoryPolicy } from '../policy/index.js';
import { getProjectRoot } from '../utils/git.js';
import { buildScaffoldPlan, type RepositoryState, type ScaffoldPlan } from './plan.js';

/**
 * Turning a plan into files — and the one place that writes anything.
 *
 * Writing is deliberately dumber than planning: it creates what the plan marked
 * `create` and touches nothing else. Every judgement about whether a file should
 * exist was already made, from the resolved policy, in `plan.ts`.
 */

export interface ApplyResult {
  written: string[];
  /** Marked `create` but found on disk between planning and writing. */
  skipped: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the `create` actions of a plan.
 *
 * Re-checks existence immediately before each write. The plan is built from the
 * resolved policy, which is cached for the process, so a file created between
 * the two would otherwise be overwritten — and "initialization is
 * non-destructive" has to hold even against itself.
 */
export async function applyScaffoldPlan(plan: ScaffoldPlan): Promise<ApplyResult> {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const item of plan.actions) {
    if (item.kind !== 'create' || item.content === undefined) continue;

    const absolute = join(plan.root, item.path);
    if (await exists(absolute)) {
      skipped.push(item.path);
      continue;
    }

    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, item.content, 'utf-8');
    written.push(item.path);
  }

  return { written, skipped };
}

export interface ResolveStateOptions {
  /** Repository root. Defaults to the git project root. */
  root?: string;
  /** Subdirectory the conventions apply to, for monorepos. */
  scope?: string | null;
}

/**
 * The repository state the planner reads, assembled from the policy layer.
 *
 * There is no second discovery here on purpose: initialization sees exactly the
 * repository every other flow sees, so it can never propose a convention that
 * discovery already found.
 */
export async function resolveRepositoryState(
  options: ResolveStateOptions = {},
): Promise<RepositoryState> {
  const root = options.root ?? (await getProjectRoot());
  const policy = await loadRepositoryPolicy({ root, scope: options.scope ?? null });

  return {
    policy,
    projectName: basename(root),
    exists: (relPath: string) => exists(join(root, relPath)),
  };
}

/** Resolve the state and build the plan, without writing anything. */
export async function planRepositoryScaffold(
  options: ResolveStateOptions = {},
): Promise<ScaffoldPlan> {
  return buildScaffoldPlan(await resolveRepositoryState(options));
}
