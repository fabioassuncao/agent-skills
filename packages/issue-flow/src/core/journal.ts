import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  createInitialSnapshot,
  MemoryPublisher,
  type MemoryPublisherOptions,
  reduceSessionEvent,
  type SessionEvent,
  type SessionPublisher,
  type SessionReducerOptions,
  type SessionSnapshot,
} from './session-state.js';

/**
 * Append-only journal of `SessionEvent`s.
 *
 * `session.json` is a *projection*: the reducer folds every event into one
 * snapshot and the events themselves are discarded. That is the right shape for
 * a dashboard and the wrong one for an audit — after a six-hour run, "what
 * happened at 3am" has no answer, because the retries, the failures and their
 * order were consumed to produce a single final state.
 *
 * This publisher writes the events instead of the state: one JSON line each, in
 * order, with a monotonic `seq`. It sits **beside** `FilePublisher`, never in
 * its place. The snapshot stays the projection; the journal is the history, and
 * replaying it through `reduceSessionEvent` reproduces the snapshot — which is
 * the property `replayJournal()` and its test exist to keep true.
 *
 * The invariant of `session-state.ts` holds here unchanged: `publish()` is
 * synchronous, never throws, and every I/O failure is swallowed after a single
 * warning. Monitoring never affects the pipeline.
 */

/** One line of `events.jsonl`. */
export interface JournalEntry {
  /** 1-based, monotonic within a file *and* across a rotation. */
  seq: number;
  event: SessionEvent;
}

/**
 * Event history is durable by default. Rotation is opt-in because retaining a
 * single previous file silently discarded older audit events.
 */
export const DEFAULT_JOURNAL_MAX_BYTES = 0;

export interface JournalPublisherOptions extends MemoryPublisherOptions {
  /**
   * Rotate once the file would grow past this. `0` (the default) disables
   * rotation; an explicit retention policy must own any deletion.
   */
  maxFileBytes?: number;
}

/**
 * Publisher that appends every event to `events.jsonl`.
 *
 * Writes are serialized on a promise chain — the same discipline as
 * `FilePublisher` — so lines never interleave and the order on disk is the
 * order of `publish()`. Nothing is throttled: dropping or coalescing events is
 * exactly what the snapshot already does, and the point of the journal is that
 * it does not.
 */
export class JournalPublisher extends MemoryPublisher {
  private readonly filePath: string;
  private readonly rotatedPath: string;
  private readonly maxFileBytes: number;
  private seq = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;
  /** Bytes in the current file. `null` until the first write measures it. */
  private bytes: number | null = null;

  constructor(filePath: string, rotatedPath: string, options: JournalPublisherOptions = {}) {
    super(options);
    this.filePath = filePath;
    this.rotatedPath = rotatedPath;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_JOURNAL_MAX_BYTES;
  }

  protected override afterPublish(event: SessionEvent): void {
    if (this.closed) return;
    this.seq++;
    const line = `${JSON.stringify({ seq: this.seq, event } satisfies JournalEntry)}\n`;
    this.enqueue(line);
  }

  private enqueue(line: string): void {
    this.writeChain = this.writeChain.then(async () => {
      try {
        await this.appendLine(line);
      } catch (err) {
        this.warnOnce(err);
      }
    });
  }

  private async appendLine(line: string): Promise<void> {
    const size = Buffer.byteLength(line);

    if (this.bytes === null) {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.bytes = await currentSize(this.filePath);
    }

    // Rotate *before* the write that would cross the ceiling, so a line is
    // never split across two files: an entry that cannot be parsed whole is
    // worse than a file slightly under its limit.
    if (this.maxFileBytes > 0 && this.bytes > 0 && this.bytes + size > this.maxFileBytes) {
      await this.rotate();
    }

    await appendFile(this.filePath, line, 'utf-8');
    this.bytes += size;
  }

  /**
   * Keep exactly one previous generation only when a caller explicitly asks
   * for rotation. The default never enters this path, so history is never
   * discarded without an explicit policy.
   */
  private async rotate(): Promise<void> {
    try {
      await unlink(this.rotatedPath);
    } catch {
      // No previous generation. Nothing to remove.
    }
    await rename(this.filePath, this.rotatedPath);
    this.bytes = 0;
  }

  override async flush(): Promise<void> {
    await this.writeChain;
  }

  override async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }
}

/** Size of `path` in bytes, or `0` when it does not exist yet. */
async function currentSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Parse the lines of a journal, skipping what cannot be read.
 *
 * A journal is appended to by a live process and read by another, so the last
 * line may well be a partial write. Tolerating it — and any line a newer
 * release wrote in a shape this one does not know — is what makes the file
 * usable at all; the alternative is a reader that throws on a healthy run.
 */
export function parseJournal(content: string): JournalEntry[] {
  const entries: JournalEntry[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!isEntry(parsed)) continue;
    entries.push(parsed);
  }

  return entries;
}

function isEntry(value: unknown): value is JournalEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { seq?: unknown; event?: unknown };
  if (typeof candidate.seq !== 'number') return false;
  const event = candidate.event;
  return (
    typeof event === 'object' && event !== null && typeof (event as SessionEvent).type === 'string'
  );
}

/**
 * Rebuild the snapshot from a journal.
 *
 * This is the reproducibility contract of the file: the same reducer that
 * produced `session.json` live, run over the events in the order they were
 * written, must land on the same state. A journal that cannot do that is a log,
 * not a journal.
 */
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

/**
 * Fan one event stream out to several publishers.
 *
 * The journal sits **beside** the snapshot writer, so something has to hold
 * both. It is the composite rather than the journal that does it, because the
 * relationship is symmetric: neither surface owns the other, and dropping
 * either one has to leave the remaining one untouched.
 *
 * `snapshot()` and `version()` answer from the first member, which is the
 * primary surface. A member that fails has already swallowed its own error —
 * that is the contract of every publisher here — so the loop needs no guard of
 * its own beyond `publish()` never throwing.
 */
export class MultiPublisher implements SessionPublisher {
  private readonly members: readonly SessionPublisher[];
  private readonly primary: SessionPublisher;

  constructor(members: readonly SessionPublisher[]) {
    if (members.length === 0) {
      throw new Error('MultiPublisher needs at least one member');
    }
    this.members = members;
    this.primary = members[0] as SessionPublisher;
  }

  publish(event: SessionEvent): void {
    for (const member of this.members) {
      member.publish(event);
    }
  }

  snapshot(): SessionSnapshot {
    return this.primary.snapshot();
  }

  version(): number {
    return this.primary.version();
  }

  async flush(): Promise<void> {
    await Promise.all(this.members.map((member) => member.flush()));
  }

  async close(): Promise<void> {
    await Promise.all(this.members.map((member) => member.close()));
  }
}
