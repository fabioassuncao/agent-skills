/**
 * Async scheduling primitives shared by the periodic monitors.
 *
 * Ported from WebMux `backend/src/lib/async.ts` @ d8c9d5f. Neither function
 * touches a Bun API, so the port keeps the original structure verbatim —
 * including the injectable scheduler, which is what lets a caller test the
 * coalescing behaviour without a real clock.
 */

/**
 * Map `items` through `fn` with at most `limit` concurrent calls, preserving
 * input order in the result.
 *
 * The worker pool exists to keep a fan-out (one `gh api` call per Pull
 * Request) from opening an unbounded number of child processes and burning the
 * GitHub rate limit in a single burst.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  // `items.length || 1` keeps the worker count at least 1 for an empty input,
  // so `Array.from({ length: 0 })` never yields a pool that resolves nothing.
  const concurrency = Math.max(1, Math.min(limit, items.length || 1));

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/** Scheduler seam, so a test drives the ticks instead of waiting for them. */
export interface SerializedIntervalDependencies<THandle = ReturnType<typeof setInterval>> {
  scheduleEvery?: (handler: () => void, intervalMs: number) => THandle;
  cancelSchedule?: (handle: THandle) => void;
}

/**
 * Run `run` immediately and then every `intervalMs`, never concurrently.
 *
 * A tick that arrives while the previous run is still in flight does not queue
 * a second execution: it sets a single rerun flag, so an overloaded sync
 * coalesces into one extra pass instead of a growing backlog. Disposal is
 * checked both before starting and after finishing, so a `stop()` issued
 * during a run cannot schedule one more.
 *
 * Returns the stop function.
 */
export function startSerializedInterval<THandle = ReturnType<typeof setInterval>>(
  run: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  deps: SerializedIntervalDependencies<THandle> = {},
): () => Promise<void> {
  const scheduleEvery =
    deps.scheduleEvery ?? ((handler, ms) => setInterval(handler, ms) as THandle);
  const cancelSchedule =
    deps.cancelSchedule ??
    ((handle) => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    });

  let running = false;
  let rerunRequested = false;
  let stopped = false;
  let active: Promise<void> = Promise.resolve();
  let controller: AbortController | null = null;

  const execute = (): void => {
    if (stopped) return;
    if (running) {
      rerunRequested = true;
      return;
    }

    running = true;
    controller = new AbortController();
    active = Promise.resolve()
      .then(() => run(controller!.signal))
      // Periodic jobs report failures at their own boundary. The scheduler
      // must still settle so stop() can await quiescence without rejecting.
      .catch(() => {})
      .finally(() => {
        running = false;
        controller = null;
        if (stopped || !rerunRequested) return;
        rerunRequested = false;
        execute();
      });
  };

  execute();
  const handle = scheduleEvery(execute, intervalMs);

  return async (): Promise<void> => {
    stopped = true;
    controller?.abort();
    cancelSchedule(handle);
    await active;
  };
}
