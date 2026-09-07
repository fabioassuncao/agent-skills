import { mkdir } from 'node:fs/promises';
import { resetAgentInvocationState } from '../../agents/invoke.js';
import { loadRuntimeConfig } from '../../config/runtime.js';
import { initResilienceConfig, loadWebConfig } from '../../config.js';
import { JournalPublisher, MultiPublisher } from '../../core/journal.js';
import { setSessionPublisher } from '../../core/session-publisher.js';
import { FilePublisher, MemoryPublisher, type SessionPublisher } from '../../core/session-state.js';
import { onShutdown } from '../../core/shutdown.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../../core/state-manager.js';
import { getInactivityTimeout, setInactivityTimeout } from '../../core/verbose.js';
import {
  type AcquireExecutionSlotResult,
  acquireExecutionSlot,
  describeSlotRefusal,
} from '../../runtime/concurrency.js';
import { getPlanRepository } from '../../storage/db/repository.js';
import { SqliteSessionPublisher } from '../../storage/db/session-publisher.js';
import {
  bindDiagnosticContext,
  flushDiagnostics,
  writeDiagnostic,
} from '../../storage/diagnostics.js';
import { describeRunLockOwner } from '../../storage/lock.js';
import { resolveIssuePaths, resolveProjectPaths } from '../../storage/resolve.js';
import type { RunLock } from '../../storage/schemas.js';
import { printError, printWarning } from '../../ui/logger.js';
import { describePreflight, getProjectRoot, preflightRepository } from '../../utils/git.js';
import { ensureWebMonitor } from '../../web/lock.js';
import { settleFinishedRun } from './auto-close.js';
import { reportIfOversized } from './oversized.js';
import type { IssueRunResult, IssueSessionInput, RunPipelinePhases } from './types.js';

/**
 * Phases that write to the repository — the working tree, the branch, or the
 * remote. The read-only ones (`init`, `prd`, `review`) produce artifacts under
 * the global storage and cannot be hurt by, nor hurt, a repository mid-rebase.
 */
const WRITING_PHASES: ReadonlySet<string> = new Set(['plan', 'execute', 'pr']);

/**
 * Refuse to hand the repository to an agent while it is in a state a human has
 * to settle first.
 *
 * **Nothing is repaired here.** A rebase in progress, an unresolved conflict, a
 * detached HEAD or a branch that is not the plan's are reported with the
 * command that gets out of them, and the phase fails. That is the Epic's second
 * limit: no destructive operation is ever run automatically to fix state, and
 * "the tool aborted my rebase overnight" is exactly the outcome it forbids.
 *
 * Two of the checks are deliberately left to `resume` rather than run here:
 *
 * - a **dirty tree** does not block mid-pipeline, because the phases of one run
 *   follow each other by design and uncommitted work between them is the
 *   pipeline's own doing;
 * - the **branch** is not compared either, because within a run the `plan`
 *   phase is what creates and checks it out, and a queue adopts a shared branch
 *   after its own plan ran.
 *
 * `resume` reads both strictly, because there the repository may have been
 * touched by anything at all in between.
 */
export async function ensureRepositoryWritable(phase: string): Promise<void> {
  if (!WRITING_PHASES.has(phase)) return;

  const preflight = await preflightRepository({ intent: 'resume-same-phase' });
  if (preflight.ok) return;

  for (const line of describePreflight(preflight)) {
    printError(line);
  }
  throw new Error(`The repository is not in a state the ${phase} phase can write to`);
}

export type RunOwnership =
  | { ok: true; interruptedBy: RunLock | null; release: () => Promise<void> }
  | { ok: false; refusal: string };

/**
 * Take an execution slot, or report why it was refused.
 *
 * At the default `runtime.maxConcurrent` of 1 this **is** the project run lock:
 * the same file, the same call, the same outcome — a project does not become
 * parallel by upgrading. Above 1 the exclusion moves to the execution unit and
 * a ceiling takes its place. `runtime/concurrency.ts` is what knows the
 * difference, and this is the single place a run asks it (§31.3).
 *
 * A project whose storage cannot be resolved at all (no git repository yet, no
 * home directory) runs **without** a lock rather than not running: the guard
 * exists to stop two runs from colliding, and it must never be the reason a
 * single run cannot start.
 */
export async function claimRunOwnership(target: string, detached = false): Promise<RunOwnership> {
  let projectDir: string;
  let projectRunLockFile: string;
  try {
    const paths = await resolveProjectPaths();
    projectDir = paths.projectDir;
    projectRunLockFile = paths.runLockFile;
  } catch {
    return { ok: true, interruptedBy: null, release: async () => {} };
  }

  // The unit is the issue this invocation is for. A queue is one run, not one
  // per issue, so the first issue names the slot the whole invocation holds.
  const { maxConcurrent } = await loadRuntimeConfig();
  const result: AcquireExecutionSlotResult = await acquireExecutionSlot({
    projectDir,
    projectRunLockFile,
    unitId: target,
    target,
    maxConcurrent,
    detached,
  });
  if (!result.ok) return { ok: false, refusal: describeSlotRefusal(result) };

  return {
    ok: true,
    interruptedBy: result.handle.reclaimedFrom,
    release: () => result.handle.release(),
  };
}

/**
 * Mark an interrupted issue as paused, in the one place resumption reads.
 *
 * `pipeline` still says which phases finished — that is what `resume` continues
 * from — and `runState` is what says *why* the run is not running: paused by a
 * person, not failed, not still going. Before this field, a `Ctrl+C` left
 * `issueStatus: 'in_progress'` and nothing else, and the difference between
 * "someone stopped it" and "it died" was unrecoverable.
 *
 * Never throws: a checkpoint that cannot be written must not stop the rest of
 * the shutdown, and the phases already marked complete are still on disk.
 */
export async function pauseIssue(tasksFile: string, issueNumber: string): Promise<void> {
  try {
    const plan = await loadTaskPlan(tasksFile);
    await saveTaskPlan(tasksFile, {
      ...plan,
      runState: {
        ...(plan.runState ?? {
          currentPhase: null,
          attempt: 0,
          lastHeartbeatAt: null,
          blockedReason: null,
          owner: null,
        }),
        status: 'paused',
        lastHeartbeatAt: isoNow(),
      },
    });
  } catch {
    // No plan yet (interrupted before the `plan` phase), or an unreadable one.
    printWarning(`Could not write a checkpoint for issue #${issueNumber}.`);
  }
}

/**
 * Run one issue with its own session publisher and web monitor registration.
 *
 * This is the body `runPipeline` always had; a queue calls it once per issue,
 * which is what gives each of them its own `session.json` (and therefore its
 * own card in the monitor) inside a single process.
 *
 * `runPipelinePhases` is injected so this module never imports the phases layer
 * — that would close a cycle through multi-issue helpers that phases call.
 */

async function createSessionPublisher(input: {
  paths: Awaited<ReturnType<typeof resolveIssuePaths>>;
  persistSnapshot: boolean;
  journalEnabled: boolean;
  webConfig: Awaited<ReturnType<typeof loadWebConfig>>;
  maxFileBytes: number | undefined;
}): Promise<SessionPublisher> {
  const { paths, persistSnapshot, journalEnabled, webConfig, maxFileBytes } = input;
  const surfaces: SessionPublisher[] = [];
  const repository = getPlanRepository(paths.tasksFile);
  if (repository !== undefined) {
    surfaces.push(
      new SqliteSessionPublisher(repository, {
        logLimit: webConfig.logLimit,
        includeLogs: webConfig.includeLogs,
      }),
    );
  }
  if (persistSnapshot || journalEnabled) {
    // resolveIssuePaths never creates directories, and a run may well be the
    // first thing to touch this issue's global folder — so the writer creates
    // it. Only when a surface asked for it: with monitoring off and no journal
    // the pipeline still creates nothing at all (issue 25, US-009).
    await mkdir(paths.issueDir, { recursive: true });
  }
  if (persistSnapshot) {
    surfaces.push(
      new FilePublisher(paths.sessionFile, {
        logLimit: webConfig.logLimit,
        includeLogs: webConfig.includeLogs,
      }),
    );
  }
  if (journalEnabled) {
    surfaces.push(
      new JournalPublisher(paths.eventsFile, paths.rotatedEventsFile, {
        logLimit: webConfig.logLimit,
        includeLogs: webConfig.includeLogs,
        ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
      }),
    );
  }
  // The snapshot writer stays the primary surface, so `snapshot()` and
  // `version()` keep answering exactly what the dashboard answered before.
  // With no disk surface the reducer still runs in memory: the terminal
  // renders that snapshot, and US-009 is preserved because nothing is written.
  return surfaces.length === 0
    ? new MemoryPublisher()
    : surfaces.length === 1
      ? (surfaces[0] as SessionPublisher)
      : new MultiPublisher(surfaces);
}

function registerIssueShutdownHooks(input: {
  paths: Awaited<ReturnType<typeof resolveIssuePaths>>;
  issueNumber: string;
  publisher: SessionPublisher;
}): { releaseCheckpoint: () => void; releaseClose: () => void } {
  const { paths, issueNumber, publisher } = input;
  // What a `Ctrl+C` leaves behind. Registered for the duration of this issue
  // only — a queue runs several, and each must checkpoint its own plan — and
  // deliberately split across the two shutdown phases: the state is written
  // while the agent is still alive, and the surfaces are closed after it is
  // gone, so nothing the checkpoint published is lost on the way out.
  const releaseCheckpoint = onShutdown({
    phase: 'checkpoint',
    run: async () => {
      await pauseIssue(paths.tasksFile, issueNumber);
      publisher.publish({
        type: 'log',
        at: isoNow(),
        level: 'warn',
        message: `Interrupted during issue #${issueNumber}. A checkpoint was saved; resume with \`issue-flow resume ${issueNumber}\`.`,
      });
      publisher.publish({ type: 'session:end', at: isoNow(), status: 'failed' });
    },
  });
  const releaseClose = onShutdown({
    phase: 'close',
    run: async () => {
      await publisher.close();
    },
  });
  return { releaseCheckpoint, releaseClose };
}

async function closeIssueSession(input: {
  releaseCheckpoint: () => void;
  releaseClose: () => void;
  result: IssueRunResult;
  publisher: SessionPublisher;
}): Promise<void> {
  const { releaseCheckpoint, releaseClose, result, publisher } = input;
  releaseCheckpoint();
  releaseClose();
  // A run that only decided to become a queue published nothing: closing the
  // session here would write a `session.json` for a pipeline that never ran.
  if (result.queue === undefined) {
    publisher.publish({
      type: 'session:end',
      at: isoNow(),
      status: result.code === 0 ? 'completed' : 'failed',
    });
  }
  // The web monitor is no longer this process's to close (US-002): it is a
  // detached, single machine-wide instance meant to outlive the pipeline
  // and serve other invocations. Only this run's own publication ends here.
  await publisher.close();
  writeDiagnostic({
    level: result.code === 0 ? 'info' : 'error',
    message: `Issue Flow session ${result.code === 0 ? 'completed' : 'failed'}`,
    context: { code: result.code, failedPhase: result.failedPhase },
  });
  await flushDiagnostics();
  setSessionPublisher(undefined);
}

async function applySessionSideEffects(input: {
  publisher: SessionPublisher;
  interruptedBy: import('../../storage/schemas.js').RunLock | undefined;
  webConfig: Awaited<ReturnType<typeof loadWebConfig>>;
  restartWeb: boolean | undefined;
}): Promise<void> {
  const { publisher, interruptedBy, webConfig, restartWeb } = input;
  // Recorded through the publisher rather than printed, so it lands in the
  // journal beside the events of the run that replaced it.
  if (interruptedBy !== undefined) {
    publisher.publish({
      type: 'log',
      at: isoNow(),
      level: 'warn',
      message: `Previous run interrupted: ${describeRunLockOwner(interruptedBy)}. Its lock was stale and has been taken over.`,
    });
  }

  // A null handle (port in use, ...) means the pipeline runs without a server.
  // ensureWebMonitor reuses an already-running, healthy instance instead of
  // binding a second one (US-001), or spawns it detached when none exists
  // (US-002) — either way the returned handle never owns a local server that
  // this process would need to close.
  if (webConfig.enabled) {
    await ensureWebMonitor(
      {
        publisher,
        port: webConfig.port,
        host: webConfig.host,
        refreshSeconds: webConfig.refreshSeconds,
      },
      { restart: restartWeb === true },
    );
  }
}

/**
 * Close out the run: the completion signals, and the optional auto-close.
 *
 * Never throws and never changes the exit code — everything here is an
 * epilogue to a verdict the pipeline already reached. A run that stopped to
 * hand control over to a queue is skipped: it is not over, the queue is about
 * to run it.
 */
async function settleIssueRun(input: {
  paths: Awaited<ReturnType<typeof resolveIssuePaths>>;
  issueNumber: string;
  publisher: SessionPublisher;
  input: IssueSessionInput;
  result: IssueRunResult;
}): Promise<void> {
  if (input.result.queue !== undefined) return;
  const context = getPlanRepository(input.paths.tasksFile);
  const runId = input.publisher.snapshot().sessionId;
  if (context === undefined || runId === null) return;
  try {
    await settleFinishedRun({
      context,
      runId,
      issueId: input.issueNumber,
      outcome: input.result.code === 0 ? 'completed' : 'failed',
      autoClose: input.input.runOptions?.autoClose === true,
      publisher: input.publisher,
    });
  } catch {
    // An epilogue that fails is not a failed run.
  }
}

export async function runIssueSession(
  issueNumber: string,
  mode: string,
  input: IssueSessionInput,
  runPipelinePhases: RunPipelinePhases,
): Promise<IssueRunResult> {
  resetAgentInvocationState();
  // Resolved once, at the top: every phase that runs below shares the process
  // cache, so the git call and the legacy migration happen a single time for
  // the whole run instead of once per phase.
  const paths = await resolveIssuePaths(issueNumber);
  try {
    const project = await resolveProjectPaths();
    bindDiagnosticContext({
      project: project.projectId,
      projectRoot: await getProjectRoot(),
      issue: issueNumber,
      sessionId: null,
      executionId: null,
      phase: null,
      story: null,
      harness: null,
      model: null,
    });
  } catch {}

  // The `resilience` key, installed once for the whole run. Every `gh` call
  // below reads it synchronously (`getActiveResilienceConfig()`), so it has to
  // be in place before the first phase resolves the Issue — and the journal
  // decision below is the first thing that reads it. Absent configuration
  // leaves the base table, so this is a no-op for a project that configured
  // nothing.
  const resilience = await initResilienceConfig();

  // The watchdog budget, when the project configured one and the CLI did not
  // override it. A flag wins because it is the higher rung of the same ladder.
  const configuredInactivity = resilience.watchdog?.inactivityTimeoutMs;
  if (configuredInactivity !== undefined && getInactivityTimeout() === undefined) {
    setInactivityTimeout(configuredInactivity);
  }

  // Read per issue rather than cached for the process: the configuration is
  // per project and cheap to read, and a cached value would leak a `--web`
  // decision from one invocation into the next inside the same process.
  const webConfig = await loadWebConfig();

  const journalEnabled = resilience.journal?.enabled === true;
  const persistSnapshot = webConfig.enabled || input.runOptions?.detachedChild === true;

  // Two independent surfaces over one event stream: the snapshot the dashboard
  // reads, and the append-only journal an audit reads. Neither implies the
  // other — `--web` without a journal is the common case, and a journal
  // without `--web` is what an unattended run wants.
  const publisher = await createSessionPublisher({
    paths,
    persistSnapshot,
    journalEnabled,
    webConfig,
    maxFileBytes: resilience.journal?.maxFileBytes,
  });
  setSessionPublisher(publisher);

  await applySessionSideEffects({
    publisher,
    interruptedBy: input.interruptedBy,
    webConfig,
    restartWeb: input.restartWeb,
  });

  let result: IssueRunResult = {
    code: 1,
    failedPhase: null,
    branchName: null,
    storyCount: 0,
    elapsedSeconds: 0,
  };

  const { releaseCheckpoint, releaseClose } = registerIssueShutdownHooks({
    paths,
    issueNumber,
    publisher,
  });

  try {
    result = await runPipelinePhases(issueNumber, paths, mode, publisher, input);
    if (result.code !== 0) {
      await reportIfOversized(issueNumber, paths, result);
    }
    // The end of the run, in the sense §17 absorbs from the oneshot watcher:
    // the agent's own `agent_stopped`/`pr_opened` corroborate what the
    // pipeline already decided, and — only when asked for — the sessions the
    // run left open are closed. A run a person took over settles nothing.
    // Deliberately after the phases and before the session is closed, so the
    // hold is re-read once the finalization has actually taken time.
    await settleIssueRun({ paths, issueNumber, publisher, input, result });
    return result;
  } finally {
    await closeIssueSession({ releaseCheckpoint, releaseClose, result, publisher });
  }
}
