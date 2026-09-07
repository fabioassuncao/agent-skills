import { describe, expect, it } from 'vitest';
import { MemoryPublisher, NullPublisher } from '../session-state.js';

describe('session publishers', () => {
  it('keeps the null publisher inert', async () => {
    const publisher = new NullPublisher();
    publisher.publish({ type: 'log', at: '2026-08-03T12:00:00Z', level: 'info', message: 'x' });
    expect(publisher.version()).toBe(0);
    expect(publisher.snapshot().logs).toEqual([]);
    await publisher.close();
  });

  it('reduces events and increments the in-memory version', () => {
    const publisher = new MemoryPublisher();
    publisher.publish({
      type: 'session:start',
      at: '2026-08-03T12:00:00Z',
      sessionId: 's',
      issueNumber: 1,
      phases: ['init'],
    });
    expect(publisher.version()).toBe(1);
    expect(publisher.snapshot()).toMatchObject({ sessionId: 's', status: 'running' });
  });

  it('can omit log entries', () => {
    const publisher = new MemoryPublisher({ includeLogs: false });
    publisher.publish({ type: 'log', at: '', level: 'info', message: 'hidden' });
    expect(publisher.version()).toBe(0);
    expect(publisher.snapshot().logs).toEqual([]);
  });
});
