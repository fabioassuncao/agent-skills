import { deriveProjectPrefix } from '../storage/projects/prefix.js';
import type { ProjectRegistry, ProjectSource } from '../storage/projects/registry.js';
import { getProjectRootOf } from '../utils/git.js';
import {
  createProjectRuntime,
  type ProjectRuntime,
  type ProjectRuntimeLike,
} from './project-runtime.js';

/**
 * The set of projects one Issue Flow process serves: a runtime per project,
 * addressed by its derived URL prefix, on top of the registry that says which
 * projects survive a restart.
 *
 * PORT + ADAPT of `backend/src/services/project-manager.ts` @ d8c9d5f. The
 * shape is the original's — `list` / `getByPrefix` / `getByPath` /
 * `loadPersisted` / `add` / `addEphemeral` / `remove` / `setActive`, the two
 * loop tiers, idempotence by resolved root, and a `loadPersisted` that logs
 * and skips instead of aborting the boot.
 *
 * Two adaptations, both forced:
 *
 * - **Asynchronous.** Resolving a root and an identity means asking git, and
 *   the identity is `projectIdFromRemote()` rather than the path. The upstream
 *   could stay synchronous because it keyed by path and read a JSON file.
 * - **Curation is a column, not a file.** `add` promotes the project to
 *   `registered`, `remove` demotes it back to `discovered`. Neither deletes:
 *   the runs, artifacts and telemetry attached to `projectId` outlive both.
 */

export interface ManagedProjectEntry {
  /** `projectIdFromRemote()` — the identity. */
  id: string;
  /** Absolute repository root. The locator. */
  root: string;
  name: string;
  /** `ephemeral` for a project served by this process only. */
  source: ProjectSource;
  addedAt: string;
}

export interface ManagedProject<R extends ProjectRuntimeLike = ProjectRuntime> {
  /** URL-path prefix and stable in-process id for this project. */
  prefix: string;
  entry: ManagedProjectEntry;
  runtime: R;
  /** Whether a client currently has this project open (drives heavy loops). */
  active: boolean;
}

/**
 * Background work for one project, split into the two liveness tiers: light
 * loops (PR/CI poll, worktree GC, queue watcher) run for every known project;
 * heavy loops (session reconciliation, terminal attach) only while active.
 */
export interface ProjectLoopController {
  startLight(): void;
  stopLight(): void;
  startHeavy(): void;
  stopHeavy(): void;
}

const NOOP_LOOPS: ProjectLoopController = {
  startLight(): void {},
  stopLight(): void {},
  startHeavy(): void {},
  stopHeavy(): void {},
};

export interface ProjectManagerDeps<R extends ProjectRuntimeLike = ProjectRuntime> {
  registry: ProjectRegistry;
  /** The single server port shared by every project. */
  port: number;
  /**
   * Build the per-project runtime. Defaults to {@link createProjectRuntime};
   * `R` is inferred from the return type so a test can supply a typed stub.
   */
  createRuntime?: (options: { projectDir: string; port: number; prefix: string }) => Promise<R> | R;
  /** Resolve an arbitrary path to its canonical repository root. */
  resolveRoot?: (path: string) => Promise<string> | string;
  /** Build the loop controller for a project. Defaults to a no-op. */
  createLoops?: (project: ManagedProject<R>) => ProjectLoopController;
  /** Warning sink. Defaults to silence — `serve` passes its own logger. */
  warn?: (message: string) => void;
}

export class ProjectManager<R extends ProjectRuntimeLike = ProjectRuntime> {
  private readonly registry: ProjectRegistry;
  private readonly port: number;
  private readonly resolveRoot: (path: string) => Promise<string> | string;
  private readonly createRuntime: (options: {
    projectDir: string;
    port: number;
    prefix: string;
  }) => Promise<R> | R;
  private readonly createLoops: (project: ManagedProject<R>) => ProjectLoopController;
  private readonly warn: (message: string) => void;
  private readonly projects = new Map<string, ManagedProject<R>>();
  private readonly loops = new Map<string, ProjectLoopController>();

  constructor(deps: ProjectManagerDeps<R>) {
    this.registry = deps.registry;
    this.port = deps.port;
    this.createRuntime =
      deps.createRuntime ?? ((options) => createProjectRuntime(options) as unknown as Promise<R>);
    this.resolveRoot = deps.resolveRoot ?? getProjectRootOf;
    this.createLoops = deps.createLoops ?? ((): ProjectLoopController => NOOP_LOOPS);
    this.warn = deps.warn ?? ((): void => {});
  }

  list(): ManagedProject<R>[] {
    return [...this.projects.values()];
  }

  getByPrefix(prefix: string): ManagedProject<R> | null {
    return this.projects.get(prefix) ?? null;
  }

  getById(projectId: string): ManagedProject<R> | null {
    for (const project of this.projects.values()) {
      if (project.entry.id === projectId) return project;
    }
    return null;
  }

  async getByPath(path: string): Promise<ManagedProject<R> | null> {
    try {
      return this.findByRoot(await this.resolveRoot(path));
    } catch {
      // A path that is not a repository simply serves no project.
      return null;
    }
  }

  /**
   * Materialize every curated project. An entry whose root has disappeared, or
   * whose configuration cannot be resolved, is logged and skipped — never
   * fatal, and never re-persisted, so a temporarily unmounted checkout is
   * still there on the next start (P5).
   */
  async loadPersisted(): Promise<ManagedProject<R>[]> {
    const loaded: ManagedProject<R>[] = [];
    for (const entry of await this.registry.listRegistered()) {
      try {
        loaded.push(await this.register(entry.root, 'registered', { persist: false }));
      } catch (error: unknown) {
        this.warn(
          `Skipping project ${entry.name ?? entry.id} (${entry.root}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return loaded;
  }

  /** Serve the project at `path` and curate it, so it comes back on restart. */
  add(path: string): Promise<ManagedProject<R>> {
    return this.register(path, 'registered', { persist: true });
  }

  /**
   * Serve the project at `path` **for this process only**.
   *
   * Used by `serve`'s cwd auto-add. The reason it does not persist is the
   * original's, and it is not obvious: with a registry shared by every server
   * on the machine, writing the cwd here would make *other* servers start
   * serving this repository on their next restart. Only `add()` persists.
   */
  addEphemeral(path: string): Promise<ManagedProject<R>> {
    return this.register(path, 'ephemeral', { persist: false });
  }

  async remove(prefix: string): Promise<void> {
    const project = this.projects.get(prefix);
    if (project === undefined) return;
    const controller = this.loops.get(prefix);
    controller?.stopHeavy();
    controller?.stopLight();
    this.projects.delete(prefix);
    this.loops.delete(prefix);
    // Demotion, not deletion: the project stops being curated and keeps every
    // run, artifact and telemetry row it ever produced.
    if (project.entry.source !== 'ephemeral') await this.registry.unregister(project.entry.id);
  }

  /**
   * Mark a project active or idle. Toggling starts/stops its heavy loops;
   * light loops are unaffected and keep running for every known project.
   */
  setActive(prefix: string, active: boolean): void {
    const project = this.projects.get(prefix);
    if (project === undefined || project.active === active) return;
    project.active = active;
    const controller = this.loops.get(prefix);
    if (active) controller?.startHeavy();
    else controller?.stopHeavy();
  }

  private findByRoot(root: string): ManagedProject<R> | null {
    for (const project of this.projects.values()) {
      if (project.entry.root === root) return project;
    }
    return null;
  }

  private async register(
    path: string,
    source: ProjectSource,
    options: { persist: boolean },
  ): Promise<ManagedProject<R>> {
    const root = await this.resolveRoot(path);
    const existing = this.findByRoot(root);
    if (existing !== null) {
      // Idempotent by resolved root: adding the same repository twice returns
      // the project that is already being served, and only ever *upgrades* its
      // persistence — an ephemeral add must not un-persist a curated project.
      if (options.persist) {
        existing.entry.source = 'registered';
        await this.registry.register({
          id: existing.entry.id,
          root,
          name: existing.entry.name,
          source: 'registered',
        });
      }
      return existing;
    }

    const prefix = deriveProjectPrefix(root, this.projects.keys());
    const runtime = await this.createRuntime({ projectDir: root, port: this.port, prefix });
    const entry: ManagedProjectEntry = {
      id: runtime.projectId,
      root,
      name: runtime.config.name,
      source,
      addedAt: new Date().toISOString(),
    };
    const project: ManagedProject<R> = { prefix, entry, runtime, active: false };
    this.projects.set(prefix, project);

    const controller = this.createLoops(project);
    this.loops.set(prefix, controller);
    controller.startLight();

    if (options.persist) {
      await this.registry.register({ id: entry.id, root, name: entry.name, source: 'registered' });
    }
    // Recency is recorded for every served project, curated or not: it is what
    // orders the "Recentes" list the dashboard shows.
    if (source !== 'ephemeral') await this.registry.touch(entry.id);
    return project;
  }
}
