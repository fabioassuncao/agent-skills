import { afterEach, describe, expect, it } from 'vitest';
import { getSessionPublisher, setSessionPublisher } from './session-publisher.js';
import { MemoryPublisher, NullPublisher } from './session-state.js';

describe('session-publisher slot', () => {
  afterEach(() => {
    setSessionPublisher(undefined);
  });

  it('defaults to a NullPublisher', () => {
    const publisher = getSessionPublisher();
    expect(publisher).toBeInstanceOf(NullPublisher);
    expect(() =>
      publisher.publish({ type: 'log', at: '2026-08-03T12:00:00Z', level: 'info', message: 'x' }),
    ).not.toThrow();
    expect(publisher.version()).toBe(0);
  });

  it('returns the installed publisher', () => {
    const memory = new MemoryPublisher();
    setSessionPublisher(memory);
    expect(getSessionPublisher()).toBe(memory);

    getSessionPublisher().publish({
      type: 'log',
      at: '2026-08-03T12:00:00Z',
      level: 'info',
      message: 'hello',
    });
    expect(memory.version()).toBe(1);
    expect(memory.snapshot().logs).toHaveLength(1);
  });

  it('resets to the NullPublisher when passed undefined', () => {
    setSessionPublisher(new MemoryPublisher());
    setSessionPublisher(undefined);
    expect(getSessionPublisher()).toBeInstanceOf(NullPublisher);
  });
});
