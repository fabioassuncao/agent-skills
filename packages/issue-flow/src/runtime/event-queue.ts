import type { AgentEvent } from '../agents/types.js';

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
