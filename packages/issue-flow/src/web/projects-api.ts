import type { ProjectInitState, ProjectInitTracker } from '../runtime/project-init.js';
import type { ManagedProjectEntry } from '../runtime/project-manager.js';
import type { ProjectRecord, ProjectRegistry } from '../storage/projects/registry.js';

/**
 * `GET/POST/DELETE /api/projects` and `GET /api/project-inits`.
 *
 * ADAPT of the upstream hub routes (`backend/src/server.ts` @ d8c9d5f). The
 * four add paths are the original's, in the original order, because each one
 * exists for a case the others get wrong: a project already being served must
 * answer immediately, a setup already in flight must not be started twice, a
 * configured repository must not be dragged through a setup it does not need,
 * and an unconfigured one must not block the request while it is prepared.
 *
 * The handlers return `{ status, body }` rather than writing to a
 * `ServerResponse`, so the whole surface is testable without a socket — the
 * same shape the rest of `server.ts` could adopt later.
 */

/**
 * What one served project looks like from here.
 *
 * Structural rather than `ManagedProject<R>` on purpose: the API never touches
 * the runtime, and depending on its type would make every consumer of this
 * module generic in something it does not use — which is also how the variance
 * fights start.
 */
export interface ManagedProjectView {
  prefix: string;
  entry: ManagedProjectEntry;
  active: boolean;
}

/** The slice of `ProjectManager` the HTTP surface actually needs. */
export interface ProjectManagerLike {
  list(): ManagedProjectView[];
  getByPrefix(prefix: string): ManagedProjectView | null;
  getByPath(path: string): Promise<ManagedProjectView | null>;
  add(path: string): Promise<ManagedProjectView>;
  remove(prefix: string): Promise<void>;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

/** One project as the dashboard and the CLI see it. */
export interface ProjectView {
  id: string;
  /** Present only while the project is being served by this process. */
  prefix: string | null;
  name: string | null;
  root: string;
  source: string;
  /** Whether a client currently has this project open. */
  active: boolean;
  /** Whether this process is serving it right now. */
  served: boolean;
  addedAt: string | null;
  lastSeenAt: string | null;
}

export interface ProjectsApiDeps {
  manager: ProjectManagerLike;
  registry: ProjectRegistry;
  tracker: ProjectInitTracker;
  /**
   * Whether mutating routes are enabled. Mirrors the rule the configuration
   * writes already follow: adding a project reaches the filesystem, so it is
   * refused on any binding that is not loopback (ADR-10).
   */
  writable: boolean;
  /** Resolve an arbitrary path to its repository root. Throws when there is none. */
  resolveRoot: (path: string) => Promise<string>;
  /** Whether the repository still needs the convention scaffold. */
  needsSetup: (root: string) => Promise<boolean>;
  /** Start the asynchronous setup. Fire and forget: the tracker reports it. */
  startSetup: (root: string) => void;
}

function toView(project: ManagedProjectView, source?: string): ProjectView {
  return {
    id: project.entry.id,
    prefix: project.prefix,
    name: project.entry.name,
    root: project.entry.root,
    source: source ?? project.entry.source,
    active: project.active,
    served: true,
    addedAt: project.entry.addedAt,
    lastSeenAt: null,
  };
}

function recordToView(record: ProjectRecord): ProjectView {
  return {
    id: record.id,
    prefix: null,
    name: record.name,
    root: record.root,
    source: record.source,
    active: false,
    served: false,
    addedAt: record.addedAt,
    lastSeenAt: record.lastSeenAt,
  };
}

/**
 * Every project the dashboard should show: the ones this process serves first,
 * then the ones the registry knows about but nothing is running for.
 *
 * That second group is the point of the whole phase — before it, a project
 * only existed once it had executed at least once, so "a project with no
 * active work" was unrepresentable.
 */
export async function listProjects(deps: ProjectsApiDeps | null): Promise<ApiResponse> {
  // A monitor bound inline by the pipeline has no project surface. Answering
  // an empty list rather than 404 is what lets one dashboard build serve both:
  // the selector simply has nothing to offer.
  if (deps === null) return { status: 200, body: { projects: [] } };
  const served = deps.manager.list();
  const known = await deps.registry.list();
  const byId = new Map(known.map((record) => [record.id, record]));

  const views: ProjectView[] = served.map((project) => {
    const record = byId.get(project.entry.id);
    const view = toView(project);
    return record === undefined
      ? view
      : { ...view, source: project.entry.source, lastSeenAt: record.lastSeenAt };
  });
  const servedIds = new Set(served.map((project) => project.entry.id));
  for (const record of known) {
    if (servedIds.has(record.id)) continue;
    views.push(recordToView(record));
  }

  return { status: 200, body: { projects: views } };
}

export interface AddProjectResponseBody {
  /** True while the repository is being set up; poll `/api/project-inits`. */
  initializing: boolean;
  /** Canonical root, so the poller knows which entry to watch. */
  path: string;
  project?: ProjectView;
}

/** `POST /api/projects { path }`. */
export async function addProject(
  deps: ProjectsApiDeps | null,
  body: unknown,
): Promise<ApiResponse> {
  if (deps === null) {
    return { status: 404, body: { error: 'This monitor does not manage projects.' } };
  }
  if (!deps.writable) {
    return {
      status: 403,
      body: { error: 'Project writes are disabled when the monitor is not bound to loopback.' },
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { error: 'Expected a JSON object.' } };
  }
  const path = (body as { path?: unknown }).path;
  if (typeof path !== 'string' || path.trim() === '') {
    return { status: 400, body: { error: 'Expected a "path" string.' } };
  }

  let root: string;
  try {
    root = await deps.resolveRoot(path);
  } catch {
    return { status: 400, body: { error: `Not a git repository: ${path}` } };
  }

  // 1. Already served — answer with what is already there.
  const existing = await deps.manager.getByPath(root);
  if (existing !== null && existing.entry.source === 'registered') {
    return { status: 200, body: { initializing: false, path: root, project: toView(existing) } };
  }

  // 2. A setup is already in flight — tell the client to poll instead of
  //    starting a second one for the same repository.
  if (deps.tracker.isActive(root)) {
    return { status: 202, body: { initializing: true, path: root } };
  }

  // 3. Already configured — serve it directly.
  if (!(await deps.needsSetup(root))) {
    const project = await deps.manager.add(root);
    return { status: 200, body: { initializing: false, path: root, project: toView(project) } };
  }

  // 4. Needs the convention scaffold. Started asynchronously so the request
  //    does not hold the connection open for a repository analysis; the phases
  //    are observable on `/api/project-inits`.
  deps.startSetup(root);
  return { status: 202, body: { initializing: true, path: root } };
}

/** `DELETE /api/projects/:prefix`. */
export async function removeProject(
  deps: ProjectsApiDeps | null,
  prefix: string,
): Promise<ApiResponse> {
  if (deps === null) {
    return { status: 404, body: { error: 'This monitor does not manage projects.' } };
  }
  if (!deps.writable) {
    return {
      status: 403,
      body: { error: 'Project writes are disabled when the monitor is not bound to loopback.' },
    };
  }
  const project = deps.manager.getByPrefix(prefix);
  if (project === null) {
    return { status: 404, body: { error: `No project served under '${prefix}'.` } };
  }
  // Order matters upstream (sockets are closed before the project leaves the
  // map, or the global handler can no longer find the cleanup). There are no
  // per-project sockets yet — the terminal transport arrives with phase 8 —
  // so the note is here to keep that ordering when they do.
  await deps.manager.remove(prefix);
  return { status: 200, body: { ok: true, prefix, id: project.entry.id } };
}

export interface ProjectInitsResponseBody {
  inits: ProjectInitState[];
}

/** `GET /api/project-inits`. */
export function listProjectInits(deps: ProjectsApiDeps | null): ApiResponse {
  return { status: 200, body: { inits: deps === null ? [] : deps.tracker.list() } };
}

/**
 * Whether the repository still has convention files to create.
 *
 * The scaffold plan is the honest answer, and it is the one already used by
 * `issue-flow init`: nothing is "configured" or "unconfigured" as a flag here,
 * it is a question about what discovery found. Any failure degrades to "no
 * setup needed", because refusing to add a project over a planning error would
 * be worse than serving it with default conventions.
 */
export async function repositoryNeedsSetup(root: string): Promise<boolean> {
  try {
    const { planRepositoryScaffold } = await import('../scaffold/apply.js');
    const plan = await planRepositoryScaffold({ root });
    return plan.actions.some((action) => action.kind === 'create');
  } catch {
    return false;
  }
}
