/**
 * Graceful shutdown: what a `Ctrl+C` does to a run that has been going for
 * hours.
 *
 * Before this module there was no `SIGINT` handler anywhere in the pipeline —
 * the only one in the project belonged to the web server — so an interrupt
 * killed the process mid-phase: nothing was marked as paused, no `session:end`
 * was published (leaving the session snapshot on `running` forever), and the `claude`
 * child was orphaned rather than asked to stop. Resumption then worked by
 * accident, because a stale `in_progress` happens to be treated as "do this
 * one first".
 *
 * The sequence here is fixed, and the order is the whole design:
 *
 * 1. **stop accepting new work** — the process-wide `AbortSignal` fires, which
 *    is the same signal every retry backoff already waits on, so a run sitting
 *    in a two-minute delay stops in that instant instead of two minutes later;
 * 2. **write the checkpoint** — while the child is still alive and the state is
 *    still coherent. Checkpointing after the kill would race the very writes it
 *    is trying to capture;
 * 3. **ask the child to stop** — `SIGTERM`, then a grace period, then
 *    `SIGKILL`. An agent given no chance to finish its sentence leaves a
 *    half-written file behind;
 * 4. **close the surfaces** — the journal and the snapshot last, so everything
 *    the previous steps published is on disk before the process ends.
 *
 * A second interrupt during the grace ends the process immediately: someone who
 * pressed `Ctrl+C` twice has said what they want, and waiting fifteen more
 * seconds to be polite is not it.
 */

/** How long a child has to exit on its own before it is killed outright. */
export const SHUTDOWN_GRACE_MS = 15_000;

/** How often the grace period checks whether the child is gone. */
const GRACE_POLL_MS = 100;

export type ShutdownReason = 'SIGINT' | 'SIGTERM';

/** Exit codes by convention: 128 + the signal number. */
const EXIT_CODES: Readonly<Record<ShutdownReason, number>> = { SIGINT: 130, SIGTERM: 143 };

/**
 * A child process the shutdown may terminate.
 *
 * Structural on purpose: an execa subprocess satisfies it without this module
 * depending on execa, and a test satisfies it with two lines.
 */
export interface TerminableChild {
  kill(signal?: NodeJS.Signals): boolean;
  /** Resolves once the process has exited, however it exited. Never rejects. */
  done: Promise<unknown>;
}

export type ShutdownPhase =
  | /** Persist state. Runs while the child is still alive. */ 'checkpoint'
  | /** Flush and close output surfaces. Runs last. */ 'close';

export interface ShutdownHook {
  phase: ShutdownPhase;
  run: (reason: ShutdownReason) => void | Promise<void>;
}

export interface InstallShutdownOptions {
  /** Grace given to a child between SIGTERM and SIGKILL. */
  graceMs?: number;
  /** Injectable exit, so a test can observe the code without dying. */
  exit?: (code: number) => void;
  /** Where the "press again" notice goes. Defaults to stderr. */
  notify?: (message: string) => void;
  /** Injectable signal source, so a test never touches the real process. */
  onSignal?: (signal: ShutdownReason, handler: () => void) => void;
}

let controller: AbortController | null = null;
let installed = false;
let shuttingDown = false;
let forced = false;
const hooks = new Set<ShutdownHook>();
const children = new Set<TerminableChild>();

/**
 * The process-wide abort signal.
 *
 * Created on first use rather than at install time, so a caller that only needs
 * the signal — a retry backoff, say — works identically whether or not handlers
 * were ever installed. That is what keeps every existing test path unchanged.
 */
export function getShutdownSignal(): AbortSignal {
  controller ??= new AbortController();
  return controller.signal;
}

/** Whether a shutdown has begun. New work must not be started after this. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Register a hook. Returns the function that removes it again. */
export function onShutdown(hook: ShutdownHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

/**
 * Register a child so the shutdown can ask it to stop.
 *
 * The returned function deregisters it, and **must** be called when the child
 * finishes normally: a set that only grows would have the shutdown signalling
 * pids that belong to something else entirely by then.
 */
export function registerChild(child: TerminableChild): () => void {
  children.add(child);
  return () => {
    children.delete(child);
  };
}

/**
 * Install the `SIGINT`/`SIGTERM` handlers, once per process.
 *
 * Idempotent by design: several entry points may call it, and a second set of
 * handlers would run the whole sequence twice — two checkpoints, two kills, two
 * exits.
 */
export function installShutdownHandlers(options: InstallShutdownOptions = {}): void {
  if (installed) return;
  installed = true;

  const listen =
    options.onSignal ??
    ((signal: ShutdownReason, handler: () => void) => {
      process.on(signal, handler);
    });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    listen(signal, () => {
      void beginShutdown(signal, options);
    });
  }
}

/**
 * Run the shutdown sequence. Exported for the callers that need to trigger it
 * without a signal (a fatal condition, a test).
 */
export async function beginShutdown(
  reason: ShutdownReason,
  options: InstallShutdownOptions = {},
): Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const notify = options.notify ?? ((message: string) => process.stderr.write(`${message}\n`));

  if (shuttingDown) {
    // Second interrupt. The person has said what they want.
    forced = true;
    killChildren('SIGKILL');
    exit(EXIT_CODES[reason]);
    return;
  }

  shuttingDown = true;
  // 1. Stop accepting new work, and cut every pending backoff short.
  getShutdownSignal();
  controller?.abort();
  notify(
    `\nInterrupted. Saving a checkpoint and stopping the agent (press ${reason === 'SIGINT' ? 'Ctrl+C' : 'the signal'} again to quit now)…`,
  );

  // 2. Checkpoint, while the child is still alive and the state is coherent.
  await runHooks('checkpoint', reason, notify);

  // 3. Ask the child to stop, then insist.
  await terminateChildren(options.graceMs ?? SHUTDOWN_GRACE_MS);

  // 4. Close the output surfaces last, so everything above is on disk.
  await runHooks('close', reason, notify);

  exit(EXIT_CODES[reason]);
}

async function runHooks(
  phase: ShutdownPhase,
  reason: ShutdownReason,
  notify: (message: string) => void,
): Promise<void> {
  for (const hook of [...hooks]) {
    if (hook.phase !== phase) continue;
    try {
      await hook.run(reason);
    } catch (err) {
      // A hook that fails must not stop the ones after it: the journal still
      // has to be closed even if the checkpoint could not be written.
      notify(
        `issue-flow: a shutdown step failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function killChildren(signal: NodeJS.Signals): void {
  for (const child of [...children]) {
    try {
      child.kill(signal);
    } catch {
      // Already gone. Nothing to do.
    }
  }
}

/**
 * `SIGTERM`, then wait, then `SIGKILL`.
 *
 * The wait ends early when every child has exited, and immediately when a
 * second interrupt arrives — polling rather than racing the `done` promises so
 * that a child which never settles cannot hold the process open forever.
 */
async function terminateChildren(graceMs: number): Promise<void> {
  if (children.size === 0) return;

  const pending = [...children];
  let alive = pending.length;
  for (const child of pending) {
    void child.done.then(
      () => {
        alive--;
      },
      () => {
        alive--;
      },
    );
  }

  killChildren('SIGTERM');

  const deadline = Date.now() + graceMs;
  while (alive > 0 && !forced && Date.now() < deadline) {
    await sleep(GRACE_POLL_MS);
  }

  if (alive > 0) killChildren('SIGKILL');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Drop every handler, hook and child. For tests only. */
export function resetShutdownState(): void {
  controller = null;
  installed = false;
  shuttingDown = false;
  forced = false;
  hooks.clear();
  children.clear();
}
