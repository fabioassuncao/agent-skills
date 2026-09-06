import { resolve as resolvePath } from 'node:path';
import {
  defaultProjectInitDeps,
  type ProjectInitDeps,
  type ProjectInitPhase,
  ProjectInitTracker,
  runProjectInit,
} from '../runtime/project-init.js';
import { resolveProjectName } from '../runtime/project-runtime.js';
import { getProjectId } from '../storage/paths.js';
import { deriveProjectPrefix } from '../storage/projects/prefix.js';
import {
  createProjectRegistry,
  type ProjectRecord,
  type ProjectRegistry,
} from '../storage/projects/registry.js';
import { printError, printInfo, printWarning } from '../ui/logger.js';
import { getProjectRootOf } from '../utils/git.js';
import { detectActiveInstance, getWebLockFile } from '../web/lock.js';
import { repositoryNeedsSetup } from '../web/projects-api.js';

/**
 * `issue-flow project ls | add | rm | use`.
 *
 * PORT + ADAPT of `bin/src/project-commands.ts` @ d8c9d5f, with the one
 * adaptation §47.5 marks as mandatory: **these commands talk to SQLite, not to
 * a server.** The upstream CLI is a thin HTTP client and prints
 * "connection refused" when nothing is listening; here the registry is the
 * authority and the server is a *consumer* of it, so `project ls` has to work
 * on a laptop with nothing running (P12). A live server is told about the
 * change afterwards, best effort, purely so it starts serving a new project
 * without being restarted.
 *
 * `migrate` is deliberately absent: it folds old single-project WebMux servers
 * into one, and there has never been an Issue Flow server per project.
 */

export interface ProjectCommandOptions {
  json?: boolean;
}

/** Seams. Production passes none of these. */
export interface ProjectCommandDeps {
  registry?: ProjectRegistry;
  resolveRoot?: (path: string) => Promise<string>;
  projectIdFor?: (root: string) => Promise<string>;
  nameFor?: (root: string) => Promise<string>;
  needsSetup?: (root: string) => Promise<boolean>;
  /** The setup steps. Injected so P1 can be exercised without touching a repo. */
  initDeps?: (
    register: (root: string) => Promise<{ prefix: string; name: string }>,
  ) => ProjectInitDeps;
  /** Notify a running monitor. Best effort: failure never fails the command. */
  notifyServer?: (change: ServerNotification) => Promise<void>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export type ServerNotification =
  | { kind: 'added'; root: string }
  | { kind: 'removed'; prefix: string | null; id: string };

interface ResolvedDeps extends Required<Omit<ProjectCommandDeps, 'registry'>> {
  registry: ProjectRegistry;
}

function resolveDeps(deps: ProjectCommandDeps): ResolvedDeps {
  return {
    registry: deps.registry ?? createProjectRegistry(),
    resolveRoot: deps.resolveRoot ?? getProjectRootOf,
    projectIdFor: deps.projectIdFor ?? getProjectId,
    nameFor: deps.nameFor ?? resolveProjectName,
    needsSetup: deps.needsSetup ?? repositoryNeedsSetup,
    initDeps: deps.initDeps ?? defaultProjectInitDeps,
    notifyServer: deps.notifyServer ?? notifyRunningServer,
    log: deps.log ?? printInfo,
    warn: deps.warn ?? printWarning,
    error: deps.error ?? printError,
  };
}

/**
 * Which prefix each project would be served under.
 *
 * Only curated projects get one, derived in registry order — the same set and
 * the same order `ProjectManager.loadPersisted()` walks, so what `ls` prints
 * is what the server will actually route. A `discovered` project has no
 * prefix because nothing is serving it.
 */
export function assignPrefixes(projects: readonly ProjectRecord[]): Map<string, string> {
  const prefixes = new Map<string, string>();
  const taken: string[] = [];
  // Oldest curated project first, whatever order the caller listed them in:
  // that is the order the server derives prefixes in, and it is what keeps the
  // first project of a given basename on the unsuffixed prefix forever.
  const curated = projects
    .filter((project) => project.source === 'registered')
    .sort(
      (left, right) =>
        (left.addedAt ?? '').localeCompare(right.addedAt ?? '') || left.id.localeCompare(right.id),
    );
  for (const project of curated) {
    const prefix = deriveProjectPrefix(project.root, taken);
    taken.push(prefix);
    prefixes.set(project.id, prefix);
  }
  return prefixes;
}

const COLUMN_WIDTHS = [14, 24, 12, 18];

/** `2026-09-06 12:05` — the day and the minute are what a person reads for. */
function formatSeen(iso: string | null): string {
  if (iso === null) return '—';
  return iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso;
}

function pad(cells: string[]): string {
  return cells
    .map((cell, index) =>
      index === cells.length - 1 ? cell : cell.padEnd(COLUMN_WIDTHS[index] ?? 12),
    )
    .join(' ');
}

export function formatProjectTable(
  projects: readonly ProjectRecord[],
  prefixes: Map<string, string>,
): string[] {
  if (projects.length === 0) {
    return ['No known project. Add one with: issue-flow project add [path]'];
  }
  const header = pad(['PREFIX', 'NAME', 'SOURCE', 'LAST SEEN', 'ROOT']);
  const rows = projects.map((project) =>
    pad([
      prefixes.get(project.id) ?? '—',
      project.name ?? project.id,
      project.source,
      formatSeen(project.lastSeenAt),
      project.root,
    ]),
  );
  return [header, ...rows];
}

/** `issue-flow project ls`. Reads SQLite directly — no server required (P12). */
export async function runProjectLs(
  options: ProjectCommandOptions = {},
  deps: ProjectCommandDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps);
  const projects = await resolved.registry.list();
  const prefixes = assignPrefixes(projects);

  if (options.json === true) {
    resolved.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          projects: projects.map((project) => ({
            ...project,
            prefix: prefixes.get(project.id) ?? null,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  for (const line of formatProjectTable(projects, prefixes)) resolved.log(line);
  return 0;
}

const PHASE_LABELS: Record<ProjectInitPhase, string> = {
  creating_config: 'Creating the missing convention files',
  analyzing: 'Analyzing the repository',
  ready: 'Project ready',
  failed: 'Setup failed',
};

/** `issue-flow project add [path]`. */
export async function runProjectAdd(
  path: string,
  _options: ProjectCommandOptions = {},
  deps: ProjectCommandDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps);
  const absolute = resolvePath(process.cwd(), path);

  let root: string;
  try {
    root = await resolved.resolveRoot(absolute);
  } catch {
    resolved.error(`Not a git repository: ${absolute}`);
    return 1;
  }

  const register = async (): Promise<{ prefix: string; name: string }> => {
    const [id, name] = await Promise.all([resolved.projectIdFor(root), resolved.nameFor(root)]);
    const record = await resolved.registry.register({ id, root, name });
    await resolved.registry.touch(id);
    const prefix =
      assignPrefixes(await resolved.registry.list()).get(record?.id ?? id) ??
      deriveProjectPrefix(root, []);
    return { prefix, name };
  };

  // A repository that still needs its convention files goes through the
  // observable setup, so the phases the dashboard shows and the ones the CLI
  // prints come from the same code (P1).
  if (await resolved.needsSetup(root)) {
    const tracker = new ProjectInitTracker();
    let lastPhase: ProjectInitPhase | null = null;
    const report = (): void => {
      const phase = tracker.get(root)?.phase ?? null;
      if (phase === null || phase === lastPhase) return;
      lastPhase = phase;
      if (phase !== 'ready' && phase !== 'failed') resolved.log(`  ${PHASE_LABELS[phase]}…`);
    };
    const initDeps = resolved.initDeps(register);
    await runProjectInit(
      tracker,
      root,
      {
        ...initDeps,
        scaffold: async (target) => {
          report();
          await initDeps.scaffold(target);
        },
        analyze: async (target) => {
          report();
          await initDeps.analyze(target);
        },
      },
      resolved.warn,
    );
    const state = tracker.get(root);
    if (state?.phase !== 'ready') {
      resolved.error(state?.error ?? 'Project setup failed.');
      return 1;
    }
    await resolved.notifyServer({ kind: 'added', root });
    resolved.log(`Added ${state.name ?? state.prefix} (${state.prefix}) — ${root}`);
    return 0;
  }

  const { prefix, name } = await register();
  await resolved.notifyServer({ kind: 'added', root });
  resolved.log(`Added ${name} (${prefix}) — ${root}`);
  return 0;
}

/**
 * Find one project from whatever the user typed: its id, the prefix it is
 * served under, or a path inside it.
 */
async function findProject(
  target: string,
  resolved: ResolvedDeps,
): Promise<{ project: ProjectRecord; prefix: string | null } | null> {
  const projects = await resolved.registry.list();
  const prefixes = assignPrefixes(projects);

  const byId = projects.find((project) => project.id === target);
  if (byId !== undefined) return { project: byId, prefix: prefixes.get(byId.id) ?? null };

  for (const [id, prefix] of prefixes) {
    if (prefix !== target) continue;
    const project = projects.find((candidate) => candidate.id === id);
    if (project !== undefined) return { project, prefix };
  }

  try {
    const root = await resolved.resolveRoot(resolvePath(process.cwd(), target));
    const byRoot = projects.find((project) => project.root === root);
    if (byRoot !== undefined) return { project: byRoot, prefix: prefixes.get(byRoot.id) ?? null };
  } catch {
    // Not a path — the two lookups above were the answer.
  }
  return null;
}

/** `issue-flow project rm <id|prefix|path>`. */
export async function runProjectRm(
  target: string,
  _options: ProjectCommandOptions = {},
  deps: ProjectCommandDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps);
  const found = await findProject(target, resolved);
  if (found === null) {
    resolved.error(`No known project matches '${target}'.`);
    return 1;
  }
  if (found.project.source !== 'registered') {
    resolved.warn(`Project '${target}' is not curated; nothing to remove.`);
    return 0;
  }

  await resolved.registry.unregister(found.project.id);
  await resolved.notifyServer({ kind: 'removed', prefix: found.prefix, id: found.project.id });
  // Said explicitly because the word "remove" invites the other reading.
  resolved.log(
    `Removed ${found.project.name ?? found.project.id} from the curated list. Its runs, artifacts and history are untouched.`,
  );
  return 0;
}

/**
 * `issue-flow project use <id|prefix|path>`.
 *
 * "Use" is recency, not a mode: it stamps `last_seen_at`, which is what orders
 * the project list everywhere. There is no active-project file to go stale,
 * and no server needs to be running for it to mean something.
 */
export async function runProjectUse(
  target: string,
  _options: ProjectCommandOptions = {},
  deps: ProjectCommandDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps);
  const found = await findProject(target, resolved);
  if (found === null) {
    resolved.error(`No known project matches '${target}'.`);
    return 1;
  }
  await resolved.registry.touch(found.project.id);
  resolved.log(`Now using ${found.project.name ?? found.project.id} — ${found.project.root}`);
  return 0;
}

/** How long the best-effort notification waits before giving up on the server. */
const SERVER_NOTIFY_TIMEOUT_MS = 1500;

/**
 * Tell a running monitor that the curated list changed.
 *
 * Strictly best effort, and never the source of truth: the registry write has
 * already happened when this runs, so a server that is down, slow or older
 * simply picks the change up on its next start.
 */
async function notifyRunningServer(change: ServerNotification): Promise<void> {
  try {
    const lock = await detectActiveInstance(getWebLockFile());
    if (lock === null) return;
    const base = `http://${lock.host === '0.0.0.0' ? '127.0.0.1' : lock.host}:${lock.port}`;
    const request =
      change.kind === 'added'
        ? new Request(`${base}/api/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: change.root }),
          })
        : change.prefix === null
          ? null
          : new Request(`${base}/api/projects/${encodeURIComponent(change.prefix)}`, {
              method: 'DELETE',
            });
    if (request === null) return;
    await fetch(request, { signal: AbortSignal.timeout(SERVER_NOTIFY_TIMEOUT_MS) });
  } catch {
    // A monitor that cannot be reached is not an error: the registry is the
    // authority and it has already been written.
  }
}
