import { describe, expect, it } from 'vitest';
import { parseJournal, replayJournal } from './journal.js';

describe('serialized session events', () => {
  const start = {
    seq: 1,
    event: {
      type: 'session:start',
      at: '2026-08-03T12:00:00Z',
      sessionId: 's',
      issueNumber: 1,
      phases: ['init'],
    },
  };

  it('parses complete records and skips incomplete input', () => {
    expect(parseJournal(`${JSON.stringify(start)}\n{"seq":`)).toEqual([start]);
  });

  it('replays records through the canonical reducer', () => {
    expect(replayJournal(JSON.stringify(start))).toMatchObject({
      sessionId: 's',
      status: 'running',
    });
  });
});
