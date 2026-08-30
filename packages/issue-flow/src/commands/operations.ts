import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJournal } from '../core/journal.js';
import { PIPELINE_PHASES, PipelineManager, type PipelinePhase } from '../core/pipeline.js';
import type { SessionEvent, SessionSnapshot } from '../core/session-state.js';
import { loadTaskPlan } from '../core/state-manager.js';
import { loadExecutionPlan } from '../execution/plan.js';
import type { ExecutionPlan } from '../execution/types.js';
import { describeRunLockOwner, isRunLockStale, readRunLock } from '../storage/lock.js';
import { getIssuePaths, QUEUES_DIR_NAME } from '../storage/paths.js';
import { resolveProjectPaths } from '../storage/resolve.js';
import type { RunLock } from '../storage/schemas.js';
import type { TaskPlan } from '../types.js';
import { printError, printInfo, printWarning } from '../ui/logger.js';

/**
 * The operation surface of a long run: `status`, `runs`, `logs`, `pause`,
 * `cancel`.
 *
 * The CLI declared thirteen commands and not one of them answered "what is
 * running", "what failed", or "stop what you are doing". During a six-hour
 * unattended execution the only way to find out was to read JSON by hand, and
 * the only way to stop it was to find the pid.
 *
 * Everything here **reads state that already exists** — `run.lock`,
 * `tasks.json`, `session.json`, `execution-plan.json`, `events.jsonl` — and
 * writes nothing except the two control commands, which do the one thing a
 * person cannot do from outside: ask the owner to stop, gracefully.
 */

interface ProjectPaths {
  projectId: string;
  projectDir: string;
  issuesDir: string;
  runLockFile: string;
}

/** One issue's state, assembled from every artifact that knows part of it. */
interface IssueState {
  id: string;
  plan: TaskPlan | null;
  snapshot: SessionSnapshot | null;
  nextPhase: PipelinePhase | null;
  paths: ReturnType<typeof getIssuePaths>;
}

async function project(): Promise<ProjectPaths | null> {
  try {
    return await resolveProjectPaths();
  } catch (err) {
    printError(`Not inside a usable project: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function loadIssueState(projectId: string, id: string): Promise<IssueState | null> {
  let paths: ReturnType<typeof getIssuePaths>;
  try {
    paths = getIssuePaths(projectId, id);
  } catch {
    return null;
  }

  let plan: TaskPlan | null = null;
  try {
    plan = await loadTaskPlan(paths.tasksFile);
  } catch {
    plan = null;
  }
  if (plan === null) return null;

  const snapshot = await readJson<SessionSnapshot>(paths.sessionFile);
  const phases: PipelinePhase[] =
    plan.noBranch === true
      ? PIPELINE_PHASES.filter((phase) => phase !== 'pr')
      : [...PIPELINE_PHASES];
  if (plan.prReview?.enabled === true) phases.push('pr-review');

  return {
    id,
    plan,
    snapshot,
    nextPhase: new PipelineManager(plan, paths.tasksFile, phases).getNextPhase(),
    paths,
  };
}

/** Every issue this project has state for, newest attempt first. */
async function allIssues(paths: ProjectPaths): Promise<IssueState[]> {
  let ids: string[];
  try {
    ids = await readdir(paths.issuesDir);
  } catch {
    return [];
  }

  const states: IssueState[] = [];
  for (const id of ids) {
    const state = await loadIssueState(paths.projectId, id);
    if (state !== null) states.push(state);
  }
  return states.sort((a, b) => attemptedAt(b.plan) - attemptedAt(a.plan));
}

function attemptedAt(plan: TaskPlan | null): number {
  const at = Date.parse(plan?.lastAttemptAt ?? '');
  return Number.isNaN(at) ? 0 : at;
}

/** Every queue plan of the project. */
async function allQueues(paths: ProjectPaths): Promise<ExecutionPlan[]> {
  const dir = join(paths.projectDir, QUEUES_DIR_NAME);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const plans: ExecutionPlan[] = [];
  for (const entry of entries) {
    const plan = await loadExecutionPlan(join(dir, entry, 'execution-plan.json'));
    if (plan !== null) plans.push(plan);
  }
  return plans;
}

/** `2m 13s ago`, or `never`. */
function since(at: string | null | undefined, now = Date.now()): string {
  if (at === null || at === undefined || at === '') return 'never';
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return 'unknown';
  return `${formatSeconds(Math.max(0, Math.round((now - parsed) / 1000)))} ago`;
}

function formatSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/* ── status ─────────────────────────────────────────────────────────────── */

export interface StatusOptions {
  /** Emit the assembled state as JSON instead of a screen. */
  json?: boolean;
}

/**
 * One screen answering "what is happening right now".
 *
 * The three artifacts each know part of it and none knows all of it: the lock
 * knows *who* and *how long since it last said anything*, the task plan knows
 * *which phase and which attempt*, and the queue plan knows *where in the
 * queue*. Reading them together is the whole command.
 */
export async function runStatus(issue?: string, options: StatusOptions = {}): Promise<number> {
  const paths = await project();
  if (paths === null) return 1;

  const lock = await readRunLock(paths.runLockFile);
  const issues =
    issue === undefined
      ? await allIssues(paths)
      : [await loadIssueState(paths.projectId, issue)].filter(
          (state): state is IssueState => state !== null,
        );
  const queues = await allQueues(paths);

  if (options.json === true) {
    printInfo(
      JSON.stringify(
        {
          owner: lock,
          ownerStale: lock === null ? null : isRunLockStale(lock),
          issues: issues.map((state) => ({
            id: state.id,
            issueStatus: state.plan?.issueStatus ?? null,
            runState: state.plan?.runState ?? null,
            nextPhase: state.nextPhase,
            branch: state.plan?.branchName ?? null,
            lastActivityAt: state.snapshot?.updatedAt ?? state.plan?.lastAttemptAt ?? null,
            retries: state.snapshot?.execution.retries ?? null,
          })),
          queues: queues.map((plan) => ({
            id: plan.id,
            status: plan.status,
            issues: plan.issues.map((entry) => ({
              id: entry.id,
              status: entry.status,
              attempts: entry.attempts,
              blockedReason: entry.blockedReason,
            })),
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  printOwner(lock);

  if (issues.length === 0) {
    printInfo('No issue in this project has any state yet.');
    return 0;
  }

  for (const state of issues.slice(0, issue === undefined ? 5 : 1)) {
    printIssueLine(state);
  }

  for (const plan of queues) {
    if (plan.status === 'completed') continue;
    printInfo(`Queue ${plan.id} — ${plan.status}`);
    for (const entry of plan.issues) {
      const attempts = entry.attempts > 0 ? `, ${entry.attempts} attempt(s)` : '';
      const blocked = entry.blockedReason === null ? '' : ` — ${entry.blockedReason}`;
      printInfo(`  #${entry.id} ${entry.status}${attempts}${blocked}`);
    }
  }

  return 0;
}

function printOwner(lock: RunLock | null): void {
  if (lock === null) {
    printInfo('Nothing is running in this project (no run.lock).');
    return;
  }
  if (isRunLockStale(lock)) {
    printWarning(`A stale lock is left behind: ${describeRunLockOwner(lock)}.`);
    printInfo('It will be taken over by the next run or resume.');
    return;
  }
  printInfo(`Running: ${describeRunLockOwner(lock)}`);
  printInfo(`Last heartbeat ${since(lock.lastHeartbeatAt)}.`);
}

function printIssueLine(state: IssueState): void {
  const plan = state.plan;
  const run = plan?.runState;
  const phase = run?.currentPhase ?? state.nextPhase ?? '—';
  const attempt = run !== undefined && run.attempt > 0 ? `, attempt ${run.attempt}` : '';
  const retries = state.snapshot?.execution.retries;
  const retryLine = retries === undefined || retries === 0 ? '' : `, ${retries} retry(ies)`;
  const activity = since(state.snapshot?.updatedAt ?? plan?.lastAttemptAt);

  printInfo(
    `#${state.id} ${plan?.issueStatus ?? 'unknown'}${run === undefined ? '' : ` / ${run.status}`}` +
      ` — phase ${phase}${attempt}${retryLine}; last activity ${activity}`,
  );
  if (run?.blockedReason !== null && run?.blockedReason !== undefined) {
    printWarning(`  Blocked: ${run.blockedReason}`);
  }
}

/* ── runs ───────────────────────────────────────────────────────────────── */

/**
 * The history: what has been run in this project, how it ended, and why.
 *
 * Deliberately built from the same artifacts `status` reads rather than from a
 * separate history file — a second record of the truth is a second thing that
 * can be wrong.
 */
export async function runRuns(): Promise<number> {
  const paths = await project();
  if (paths === null) return 1;

  const issues = await allIssues(paths);
  if (issues.length === 0) {
    printInfo('No runs recorded for this project yet.');
    return 0;
  }

  for (const state of issues) {
    const plan = state.plan;
    if (plan === null) continue;
    const duration =
      state.snapshot?.elapsedSeconds === null || state.snapshot?.elapsedSeconds === undefined
        ? '—'
        : formatSeconds(state.snapshot.elapsedSeconds);
    const cause =
      plan.lastError === null ? '' : ` — ${plan.lastError.message.split('\n')[0] ?? ''}`;

    printInfo(
      `#${state.id.padEnd(6)} ${plan.issueStatus.padEnd(12)} ${duration.padEnd(10)} ` +
        `last attempt ${since(plan.lastAttemptAt)}${cause}`,
    );
  }
  return 0;
}

/* ── logs ───────────────────────────────────────────────────────────────── */

export interface LogsOptions {
  /** Only these event types (`retry`, `phase:end`, …). Empty means all. */
  kind?: string[];
  /** Keep reading as the journal grows. */
  follow?: boolean;
  /** How many entries to show before following. */
  tail?: number;
  /** Polling interval of `--follow`, for tests. */
  pollMs?: number;
  /** Stops `--follow`. */
  signal?: AbortSignal;
}

const DEFAULT_TAIL = 50;
const FOLLOW_POLL_MS = 1000;

/**
 * Read the journal, filtered and readable.
 *
 * The journal is the only record that keeps *what happened in which order* —
 * the snapshot folded it away — so this is the command that answers "what was
 * it doing at 3am". `--kind retry,failover` is the filter that matters most:
 * on a six-hour run those are a handful of lines among thousands.
 */
export async function runLogs(issue?: string, options: LogsOptions = {}): Promise<number> {
  const paths = await project();
  if (paths === null) return 1;

  const target = issue ?? (await allIssues(paths))[0]?.id;
  if (target === undefined) {
    printInfo('No issue in this project has a journal yet.');
    return 0;
  }

  const issuePaths = getIssuePaths(paths.projectId, target);
  const kinds = new Set(options.kind ?? []);
  const tail = options.tail ?? DEFAULT_TAIL;

  const shown = new Set<number>();
  const render = (content: string, limit: number | null): void => {
    const entries = parseJournal(content).filter(
      (entry) => kinds.size === 0 || kinds.has(entry.event.type),
    );
    const slice = limit === null ? entries : entries.slice(-limit);
    for (const entry of slice) {
      if (shown.has(entry.seq)) continue;
      shown.add(entry.seq);
      printInfo(formatEvent(entry.seq, entry.event));
    }
  };

  const readAll = async (): Promise<string> =>
    `${await readIfPresent(issuePaths.rotatedEventsFile)}${await readIfPresent(issuePaths.eventsFile)}`;

  const initial = await readAll();
  if (initial === '') {
    printInfo(
      `Issue #${target} has no journal. Enable it with resilience.journal.enabled or --continuous.`,
    );
    return 0;
  }
  render(initial, tail);

  if (options.follow !== true) return 0;

  const poll = options.pollMs ?? FOLLOW_POLL_MS;
  const signal = options.signal;
  while (signal === undefined || !signal.aborted) {
    await sleep(poll, signal);
    if (signal?.aborted === true) break;
    render(await readAll(), null);
  }
  return 0;
}

function formatEvent(seq: number, event: SessionEvent): string {
  const at = 'at' in event ? event.at : '';
  const detail = describeEvent(event);
  return `${String(seq).padStart(5)} ${at} ${event.type}${detail === '' ? '' : ` — ${detail}`}`;
}

function describeEvent(event: SessionEvent): string {
  switch (event.type) {
    case 'phase:start':
      return event.phase;
    case 'phase:end':
      return `${event.phase} ${event.success ? 'ok' : `failed: ${event.error ?? ''}`}`;
    case 'retry':
      return `attempt ${event.attempt}, ${event.delaySeconds}s — ${event.reason}`;
    case 'log':
      return `${event.level}: ${event.message}`;
    case 'session:end':
      return event.status;
    default:
      return '';
  }
}

async function readIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/* ── pause and cancel ───────────────────────────────────────────────────── */

export interface ControlOptions {
  /** Injectable signaller, so a test never signals a real process. */
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Ask the running owner to stop, gracefully.
 *
 * `SIGTERM` is the whole implementation, and deliberately so: the owner already
 * knows how to stop well (`core/shutdown.ts` writes the checkpoint, stops the
 * agent with a grace period and closes the journal). Reimplementing any of that
 * from outside the process would be a second, worse version of it.
 */
export async function runPause(options: ControlOptions = {}): Promise<number> {
  return stopOwner('paused', options);
}

/**
 * Stop the run and mark it so a later `resume` does not pick it up silently.
 *
 * The difference from `pause` is not in how the process ends — it ends the same
 * way — but in what the state says afterwards: a paused run is meant to be
 * resumed, a cancelled one is not.
 */
export async function runCancel(issue?: string, options: ControlOptions = {}): Promise<number> {
  const code = await stopOwner('cancelled', options);
  if (code !== 0) return code;

  const paths = await project();
  if (paths === null) return 1;

  const target = issue ?? (await allIssues(paths))[0]?.id;
  if (target === undefined) return 0;

  const state = await loadIssueState(paths.projectId, target);
  if (state === null || state.plan === null) return 0;

  const { saveTaskPlan, isoNow } = await import('../core/state-manager.js');
  await saveTaskPlan(state.paths.tasksFile, {
    ...state.plan,
    runState: {
      currentPhase: state.plan.runState?.currentPhase ?? null,
      attempt: state.plan.runState?.attempt ?? 0,
      owner: null,
      status: 'blocked',
      blockedReason: 'Cancelled by the user',
      lastHeartbeatAt: isoNow(),
    },
  });
  printInfo(`Issue #${target} is marked cancelled. A resume will report it instead of running it.`);
  return 0;
}

async function stopOwner(intent: string, options: ControlOptions): Promise<number> {
  const paths = await project();
  if (paths === null) return 1;

  const lock = await readRunLock(paths.runLockFile);
  if (lock === null) {
    printInfo('Nothing is running in this project.');
    return 0;
  }
  if (isRunLockStale(lock)) {
    printWarning(`The lock is stale (${describeRunLockOwner(lock)}); nothing to stop.`);
    return 0;
  }

  const send =
    options.signalProcess ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  try {
    send(lock.pid, 'SIGTERM');
  } catch (err) {
    printError(
      `Could not signal pid ${lock.pid}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  printInfo(
    `Asked pid ${lock.pid} to stop (${intent}). It writes a checkpoint, stops the agent and closes its journal before exiting.`,
  );
  return 0;
}
