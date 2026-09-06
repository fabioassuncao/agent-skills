/**
 * Setting a repository up the first time it is added, as an observable
 * sequence of phases rather than one opaque wait.
 *
 * MERGE of `backend/src/services/project-init-service.ts` @ d8c9d5f with the
 * plan-then-apply scaffold this project already has (`src/scaffold/`, §47.5).
 * What comes from the upstream is the part that was missing here: a phase
 * tracker with a TTL, and an asynchronous flow a client can watch while it
 * runs. What stays is the scaffold itself — it is non-destructive and
 * idempotent, which the upstream's "write the starter YAML" is not.
 *
 * The phase names are the upstream's, because they are what the CLI and the
 * dashboard render: `creating_config` → `analyzing` → `ready` | `failed`.
 */

export type ProjectInitPhase = 'creating_config' | 'analyzing' | 'ready' | 'failed';

export interface ProjectInitState {
  /** Canonical (repository root) path being set up — the tracker key. */
  path: string;
  phase: ProjectInitPhase;
  /** Set once the project is being served (phase `ready`). */
  prefix: string | null;
  name: string | null;
  /** Set when the phase is `failed`. */
  error: string | null;
  updatedAt: number;
}

const DEFAULT_TERMINAL_TTL_MS = 60_000;

function isTerminal(phase: ProjectInitPhase): boolean {
  return phase === 'ready' || phase === 'failed';
}

/**
 * Hub-level record of in-flight (and recently finished) project setups.
 *
 * Terminal entries are kept briefly so a poller that arrives late still sees
 * the outcome, then evicted by TTL; in-flight entries never expire. Both
 * halves matter: without the TTL the map grows for the life of the server,
 * and without the grace period a client that polls a beat too slowly is told
 * nothing ever happened.
 */
export class ProjectInitTracker {
  private readonly inits = new Map<string, ProjectInitState>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TERMINAL_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  set(
    path: string,
    update: { phase: ProjectInitPhase; prefix?: string; name?: string; error?: string },
  ): void {
    const existing = this.inits.get(path);
    this.inits.set(path, {
      path,
      phase: update.phase,
      prefix: update.prefix ?? existing?.prefix ?? null,
      name: update.name ?? existing?.name ?? null,
      error: update.error ?? (update.phase === 'failed' ? (existing?.error ?? null) : null),
      updatedAt: this.now(),
    });
  }

  get(path: string): ProjectInitState | null {
    return this.inits.get(path) ?? null;
  }

  /** True while a setup is mid-flight for `path` (not yet ready/failed). */
  isActive(path: string): boolean {
    const state = this.inits.get(path);
    return state !== undefined && !isTerminal(state.phase);
  }

  /** Live view: drops terminal entries past their TTL. */
  list(): ProjectInitState[] {
    const cutoff = this.now() - this.ttlMs;
    for (const [path, state] of this.inits) {
      if (isTerminal(state.phase) && state.updatedAt < cutoff) this.inits.delete(path);
    }
    return [...this.inits.values()];
  }
}

/** The I/O the orchestration needs, injected so it stays unit-testable. */
export interface ProjectInitDeps {
  /**
   * Whether the analysis step can run at all.
   *
   * Upstream this asked whether the agent CLI used to flesh out the generated
   * YAML was on PATH. Here the analysis is a local discovery pass, so the
   * default is always `true`; the seam is kept because it is where an
   * agent-driven enrichment attaches without changing this flow.
   */
  analyzerAvailable: () => boolean;
  /** Create the convention files the repository is missing. */
  scaffold: (root: string) => Promise<void>;
  /** Resolve what the repository now declares, after the scaffold. */
  analyze: (root: string) => Promise<void>;
  /** Serve and curate the project; returns its prefix and label. */
  register: (root: string) => Promise<{ prefix: string; name: string }>;
}

/**
 * Drive an on-add project setup, updating `tracker` so the CLI and the
 * dashboard can watch: create the missing configuration → analyze the
 * repository (best effort; skipped when unavailable, non-fatal on error so the
 * starter configuration still ships) → serve the project → ready.
 *
 * A scaffold or registration failure is terminal. An analysis failure is not:
 * stranding the user with no project at all, because an enrichment step threw,
 * is strictly worse than a project with default conventions.
 */
export async function runProjectInit(
  tracker: ProjectInitTracker,
  root: string,
  deps: ProjectInitDeps,
  onWarn?: (message: string) => void,
): Promise<void> {
  try {
    tracker.set(root, { phase: 'creating_config' });
    await deps.scaffold(root);

    if (deps.analyzerAvailable()) {
      tracker.set(root, { phase: 'analyzing' });
      try {
        await deps.analyze(root);
      } catch (error: unknown) {
        onWarn?.(
          `Analysis failed for ${root}, keeping the starter configuration: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const { prefix, name } = await deps.register(root);
    tracker.set(root, { phase: 'ready', prefix, name });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    tracker.set(root, { phase: 'failed', error: message });
  }
}

/**
 * The production wiring of {@link ProjectInitDeps}.
 *
 * `scaffold` is the existing plan-then-apply pass: it creates only what is
 * missing and never overwrites, so running it on a repository that is already
 * configured is a no-op rather than a rewrite. `analyze` re-resolves the
 * repository policy afterwards, which is what turns the freshly written files
 * into the conventions the project runtime will actually use.
 */
export function defaultProjectInitDeps(
  register: (root: string) => Promise<{ prefix: string; name: string }>,
): ProjectInitDeps {
  return {
    analyzerAvailable: () => true,
    scaffold: async (root) => {
      const { applyScaffoldPlan, planRepositoryScaffold } = await import('../scaffold/apply.js');
      await applyScaffoldPlan(await planRepositoryScaffold({ root }));
    },
    analyze: async (root) => {
      const { loadRepositoryPolicy } = await import('../policy/index.js');
      // `cache: false` is the point: the scaffold has just written files, so a
      // cached answer would describe the repository as it was a moment ago.
      await loadRepositoryPolicy({ root, scope: null, cache: false });
    },
    register,
  };
}
