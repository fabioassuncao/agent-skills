import type { AgentEvent } from '../agents/types.js';

/**
 * The bridge between a push-only producer and a pull-only consumer.
 *
 * Every mode observes its agent through the same shape: something pushes events
 * as they happen (`invocation.onEvent` in `headless`, a lifecycle hook in the
 * pane modes) and `observe()` hands them out through `for await`. The queue is
 * what lets those two meet without either one polling the other, and it closes
 * exactly once, when the invocation ends.
 *
 * It lives in its own file because all three modes need it. A second copy of
 * these forty lines is the duplication §25 forbids, and the failure mode of a
 * near-copy is not a compile error: it is one mode dropping the event that was
 * pushed while nobody was awaiting.
 */
export interface AgentEventQueue {
  push: (event: AgentEvent) => void;
  /** Idempotent. Ends the iterable, resolving a consumer that is waiting. */
  close: () => void;
  iterable: AsyncIterable<AgentEvent>;
}

export function createAgentEventQueue(): AgentEventQueue {
  const buffered: AgentEvent[] = [];
  let waiting: ((result: IteratorResult<AgentEvent>) => void) | null = null;
  let closed = false;

  return {
    push: (event) => {
      if (closed) return;
      if (waiting !== null) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: event, done: false });
        return;
      }
      buffered.push(event);
    },
    close: () => {
      if (closed) return;
      closed = true;
      if (waiting !== null) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: undefined, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const next = buffered.shift();
          if (next !== undefined) return Promise.resolve({ value: next, done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true } as const);
          return new Promise<IteratorResult<AgentEvent>>((resolve) => {
            waiting = resolve;
          });
        },
      }),
    },
  };
}
