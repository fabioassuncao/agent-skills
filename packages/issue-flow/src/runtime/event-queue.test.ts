import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agents/types.js';
import { createAgentEventQueue } from './event-queue.js';

/**
 * The queue every mode observes through.
 *
 * Its whole job is the two orderings that are easy to get wrong: an event
 * pushed before anyone is waiting must not be dropped, and a consumer already
 * waiting must be woken rather than left hanging when the producer closes.
 */
describe('the agent event queue', () => {
  it('buffers what was pushed before anybody started consuming', async () => {
    const queue = createAgentEventQueue();
    queue.push({ kind: 'text', text: 'first' });
    queue.push({ kind: 'tool', name: 'Read' });
    queue.close();

    const collected: AgentEvent[] = [];
    for await (const event of queue.iterable) collected.push(event);

    expect(collected).toEqual([
      { kind: 'text', text: 'first' },
      { kind: 'tool', name: 'Read' },
    ]);
  });

  it('wakes a consumer that is already waiting', async () => {
    const queue = createAgentEventQueue();
    const collected: AgentEvent[] = [];
    const consuming = (async () => {
      for await (const event of queue.iterable) collected.push(event);
    })();

    await new Promise((resolve) => setImmediate(resolve));
    queue.push({ kind: 'text', text: 'late' });
    queue.close();
    await consuming;

    expect(collected).toEqual([{ kind: 'text', text: 'late' }]);
  });

  it('ignores a push after close, and closes only once', async () => {
    const queue = createAgentEventQueue();
    queue.close();
    queue.close();
    queue.push({ kind: 'text', text: 'too late' });

    const collected: AgentEvent[] = [];
    for await (const event of queue.iterable) collected.push(event);
    expect(collected).toEqual([]);
  });
});
