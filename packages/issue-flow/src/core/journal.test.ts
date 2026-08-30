import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_JOURNAL_MAX_BYTES,
  JournalPublisher,
  MultiPublisher,
  parseJournal,
  replayJournal,
} from './journal.js';
import {
  FilePublisher,
  MemoryPublisher,
  type SessionEvent,
  type SessionPublisher,
} from './session-state.js';

let dir: string;
let eventsFile: string;
let rotatedFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'issue-flow-journal-'));
  eventsFile = join(dir, 'events.jsonl');
  rotatedFile = join(dir, 'events.1.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A realistic slice of a run: two phases, a retry, a failure and the end. */
function scriptedRun(): SessionEvent[] {
  return [
    {
      type: 'session:start',
      at: '2026-08-30T03:00:00.000Z',
      sessionId: 'sess-1',
      issueNumber: 63,
      phases: ['prd', 'execute'],
    },
    { type: 'phase:start', at: '2026-08-30T03:00:01.000Z', phase: 'prd' },
    {
      type: 'retry',
      at: '2026-08-30T03:02:00.000Z',
      phase: 'prd',
      attempt: 1,
      maxAttempts: 3,
      delaySeconds: 15,
      reason: 'claude exited with code 143',
      kind: 'timeout',
    },
    { type: 'phase:end', at: '2026-08-30T03:05:00.000Z', phase: 'prd', success: true },
    { type: 'phase:start', at: '2026-08-30T03:05:01.000Z', phase: 'execute' },
    {
      type: 'phase:end',
      at: '2026-08-30T03:40:00.000Z',
      phase: 'execute',
      success: false,
      error: 'Tests failed',
    },
    { type: 'session:end', at: '2026-08-30T03:40:01.000Z', status: 'failed' },
  ];
}

async function publishAll(publisher: SessionPublisher, events: SessionEvent[]): Promise<void> {
  for (const event of events) {
    publisher.publish(event);
  }
  await publisher.close();
}

describe('JournalPublisher', () => {
  it('appends one JSON line per event, with a monotonic seq', async () => {
    const journal = new JournalPublisher(eventsFile, rotatedFile);
    const events = scriptedRun();

    await publishAll(journal, events);

    const lines = (await readFile(eventsFile, 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(events.length);

    const entries = lines.map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(entries.map((entry) => entry.event.type)).toEqual(events.map((event) => event.type));
    // Nothing is summarised away: the retry that a snapshot would have folded
    // into a counter is on disk with its reason and its classified kind.
    expect(entries[2].event).toMatchObject({ reason: expect.stringContaining('143') });
  });

  it('preserves the order events were published in', async () => {
    const journal = new JournalPublisher(eventsFile, rotatedFile);
    const many: SessionEvent[] = Array.from({ length: 50 }, (_, index) => ({
      type: 'log',
      at: '2026-08-30T03:00:00.000Z',
      level: 'info',
      message: `line ${index}`,
    }));

    await publishAll(journal, many);

    const entries = parseJournal(await readFile(eventsFile, 'utf-8'));
    expect(entries.map((entry) => entry.seq)).toEqual(many.map((_, index) => index + 1));
    expect(entries.map((entry) => (entry.event as { message: string }).message)).toEqual(
      many.map((_, index) => `line ${index}`),
    );
  });

  it('appends to an existing journal instead of truncating it', async () => {
    await writeFile(eventsFile, '{"seq":1,"event":{"type":"log","at":"x","level":"info"}}\n');

    const journal = new JournalPublisher(eventsFile, rotatedFile);
    await publishAll(journal, [
      { type: 'phase:start', at: '2026-08-30T03:00:00.000Z', phase: 'prd' },
    ]);

    const lines = (await readFile(eventsFile, 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('creates the issue directory when it is the first thing to write', async () => {
    const nested = join(dir, 'projects', 'p', 'issues', '63');
    const journal = new JournalPublisher(
      join(nested, 'events.jsonl'),
      join(nested, 'events.1.jsonl'),
    );

    await publishAll(journal, [
      { type: 'phase:start', at: '2026-08-30T03:00:00.000Z', phase: 'prd' },
    ]);

    await expect(stat(join(nested, 'events.jsonl'))).resolves.toBeDefined();
  });
});

describe('rotation', () => {
  it('moves the file aside once it would grow past maxFileBytes', async () => {
    const journal = new JournalPublisher(eventsFile, rotatedFile, { maxFileBytes: 200 });
    const events: SessionEvent[] = Array.from({ length: 20 }, (_, index) => ({
      type: 'log',
      at: '2026-08-30T03:00:00.000Z',
      level: 'info',
      message: `a fairly long line number ${index}`,
    }));

    await publishAll(journal, events);

    const current = await readFile(eventsFile, 'utf-8');
    const rotated = await readFile(rotatedFile, 'utf-8');

    expect(current.length).toBeGreaterThan(0);
    expect(rotated.length).toBeGreaterThan(0);
    // Every line is whole on one side or the other — rotation happens before
    // the write that would cross the ceiling, never in the middle of one — and
    // the two generations are contiguous, ending on the last event published.
    const all = [...parseJournal(rotated), ...parseJournal(current)];
    const seqs = all.map((entry) => entry.seq);
    expect(seqs).toEqual(seqs.map((_, index) => (seqs[0] as number) + index));
    expect(seqs.at(-1)).toBe(events.length);
    expect(current.endsWith('\n')).toBe(true);
    expect(rotated.endsWith('\n')).toBe(true);
  });

  it('keeps exactly one previous generation', async () => {
    await writeFile(rotatedFile, '{"seq":0,"event":{"type":"log","at":"old","level":"info"}}\n');
    const journal = new JournalPublisher(eventsFile, rotatedFile, { maxFileBytes: 120 });

    await publishAll(
      journal,
      Array.from({ length: 12 }, (_, index) => ({
        type: 'log' as const,
        at: '2026-08-30T03:00:00.000Z',
        level: 'info' as const,
        message: `line ${index}`,
      })),
    );

    // The stale generation is gone, not stacked into events.2.jsonl.
    expect(await readFile(rotatedFile, 'utf-8')).not.toContain('"old"');
  });

  it('never rotates when maxFileBytes is 0', async () => {
    const journal = new JournalPublisher(eventsFile, rotatedFile, { maxFileBytes: 0 });

    await publishAll(
      journal,
      Array.from({ length: 30 }, () => ({
        type: 'log' as const,
        at: '2026-08-30T03:00:00.000Z',
        level: 'info' as const,
        message: 'x'.repeat(100),
      })),
    );

    await expect(stat(rotatedFile)).rejects.toThrow();
  });

  it('defaults to unbounded retention', () => {
    expect(DEFAULT_JOURNAL_MAX_BYTES).toBe(0);
  });
});

describe('the journal reproduces the snapshot', () => {
  it('replays into a state equivalent to the live one', async () => {
    const events = scriptedRun();

    const live = new MemoryPublisher();
    for (const event of events) live.publish(event);

    const journal = new JournalPublisher(eventsFile, rotatedFile);
    await publishAll(journal, events);

    const replayed = replayJournal(await readFile(eventsFile, 'utf-8'));

    expect(replayed).toEqual(live.snapshot());
  });

  it('replays a rotated journal when both generations are read in order', async () => {
    const events = scriptedRun();

    const live = new MemoryPublisher();
    for (const event of events) live.publish(event);

    // Sized so the run rotates exactly once: with two generations kept, a
    // single rotation is the case where the whole history is still on disk.
    const journal = new JournalPublisher(eventsFile, rotatedFile, { maxFileBytes: 600 });
    await publishAll(journal, events);

    const rotated = await readFile(rotatedFile, 'utf-8').catch(() => '');
    const current = await readFile(eventsFile, 'utf-8');

    expect(replayJournal(rotated + current)).toEqual(live.snapshot());
  });
});

describe('parseJournal', () => {
  it('skips a truncated last line instead of throwing', () => {
    const content =
      '{"seq":1,"event":{"type":"phase:start","at":"x","phase":"prd"}}\n{"seq":2,"eve';

    const entries = parseJournal(content);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.seq).toBe(1);
  });

  it('skips a line that is valid JSON but not an entry', () => {
    const content = '{"seq":1,"event":{"type":"log","at":"x","level":"info"}}\n42\n{"seq":2}\n';

    expect(parseJournal(content)).toHaveLength(1);
  });

  it('reads an empty journal as no entries', () => {
    expect(parseJournal('')).toEqual([]);
    expect(parseJournal('\n\n')).toEqual([]);
  });
});

describe('the pipeline is never affected', () => {
  it('swallows an I/O failure after a single warning', async () => {
    const onWarn = vi.fn();
    // A path whose parent is a file, so every append fails.
    const blocked = join(dir, 'not-a-dir');
    await writeFile(blocked, 'x');
    const journal = new JournalPublisher(
      join(blocked, 'events.jsonl'),
      join(blocked, 'events.1.jsonl'),
      { onWarn },
    );

    expect(() => {
      journal.publish({ type: 'phase:start', at: 'x', phase: 'prd' });
      journal.publish({ type: 'phase:start', at: 'x', phase: 'plan' });
    }).not.toThrow();
    await journal.close();

    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it('drops every event after close', async () => {
    const journal = new JournalPublisher(eventsFile, rotatedFile);
    await publishAll(journal, [{ type: 'phase:start', at: 'x', phase: 'prd' }]);

    journal.publish({ type: 'phase:start', at: 'x', phase: 'plan' });
    await journal.flush();

    expect(parseJournal(await readFile(eventsFile, 'utf-8'))).toHaveLength(1);
  });
});

describe('MultiPublisher', () => {
  it('fans every event out to each member', async () => {
    const snapshotWriter = new FilePublisher(join(dir, 'session.json'), { throttleMs: 0 });
    const journal = new JournalPublisher(eventsFile, rotatedFile);
    const both = new MultiPublisher([snapshotWriter, journal]);

    await publishAll(both, scriptedRun());

    const session = JSON.parse(await readFile(join(dir, 'session.json'), 'utf-8'));
    const entries = parseJournal(await readFile(eventsFile, 'utf-8'));

    expect(entries).toHaveLength(7);
    // The snapshot is still the projection, unchanged by the journal beside it.
    expect(session.status).toBe('failed');
    expect(replayJournal(await readFile(eventsFile, 'utf-8'))).toEqual(snapshotWriter.snapshot());
  });

  it('answers snapshot() and version() from the first member', () => {
    const primary = new MemoryPublisher();
    const secondary = new MemoryPublisher();
    const both = new MultiPublisher([primary, secondary]);

    both.publish({ type: 'phase:start', at: 'x', phase: 'prd' });

    expect(both.snapshot()).toBe(primary.snapshot());
    expect(both.version()).toBe(primary.version());
    // The second member saw it too — it is a fan-out, not a fallback.
    expect(secondary.version()).toBe(1);
  });

  it('refuses to be built with no members', () => {
    expect(() => new MultiPublisher([])).toThrow(/at least one member/);
  });
});
