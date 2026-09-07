import {
  createInitialSnapshot,
  reduceSessionEvent,
  type SessionEvent,
  type SessionReducerOptions,
  type SessionSnapshot,
} from './session-state.js';

export interface JournalEntry {
  seq: number;
  event: SessionEvent;
}

/** Parse serialized event records while tolerating incomplete diagnostic input. */
export function parseJournal(content: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isEntry(parsed)) entries.push(parsed);
    } catch {}
  }
  return entries;
}

function isEntry(value: unknown): value is JournalEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { seq?: unknown; event?: unknown };
  return (
    typeof candidate.seq === 'number' &&
    typeof candidate.event === 'object' &&
    candidate.event !== null &&
    typeof (candidate.event as SessionEvent).type === 'string'
  );
}

export function replayJournal(
  content: string,
  options: SessionReducerOptions = {},
): SessionSnapshot {
  let snapshot = createInitialSnapshot();
  for (const entry of parseJournal(content)) {
    snapshot = reduceSessionEvent(snapshot, entry.event, options);
  }
  return snapshot;
}
