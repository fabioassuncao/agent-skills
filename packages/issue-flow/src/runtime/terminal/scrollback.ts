/**
 * What a viewer that connects late, or reconnects, needs to see.
 *
 * Ported from the scrollback ring of WebMux `backend/src/adapters/terminal.ts`
 * @ d8c9d5f, with the **sequence offset** §15 requires as a mandatory addition.
 *
 * The upstream replays its whole 1 MB buffer on every reconnect — and a browser
 * reconnects on `visibilitychange`, `focus` and `online`, so switching tabs
 * twice costs two megabytes and a full terminal repaint. Numbering the bytes
 * lets a returning client say how far it got and receive only the difference.
 */

/** Ring capacity. The upstream's, and it is about one screen of history at any width. */
export const MAX_SCROLLBACK_BYTES = 1024 * 1024;

export interface ScrollbackReplay {
  /** Text to write to the terminal. */
  data: string;
  /** Offset the client has after applying it. */
  offset: number;
  /**
   * True when the requested offset had already been evicted, so this is the
   * oldest history that still exists rather than the continuation asked for.
   * A client that receives it must clear its screen before writing.
   */
  truncated: boolean;
}

/**
 * A byte-numbered ring of terminal output.
 *
 * Offsets are monotonic across the whole life of the session and never reused,
 * so "I have up to N" is unambiguous even after eviction. `oldestOffset` is
 * where the retained window starts.
 */
export class Scrollback {
  private chunks: string[] = [];
  private bytes = 0;
  /** Total bytes ever appended. Also the offset of the next byte. */
  private end = 0;
  /** Offset of the first byte still retained. */
  private start = 0;

  constructor(private readonly maxBytes: number = MAX_SCROLLBACK_BYTES) {}

  get offset(): number {
    return this.end;
  }

  get oldestOffset(): number {
    return this.start;
  }

  get retainedBytes(): number {
    return this.bytes;
  }

  append(chunk: string): void {
    if (chunk === '') return;
    const size = Buffer.byteLength(chunk, 'utf-8');
    this.chunks.push(chunk);
    this.bytes += size;
    this.end += size;

    // Evict whole chunks from the front. Splitting one would risk cutting a
    // multi-byte character or an escape sequence in half, and a terminal
    // handed half an escape sequence renders garbage from there on.
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const evicted = this.chunks.shift() as string;
      const evictedSize = Buffer.byteLength(evicted, 'utf-8');
      this.bytes -= evictedSize;
      this.start += evictedSize;
    }
  }

  /** Everything retained, as one string. */
  all(): string {
    return this.chunks.join('');
  }

  /**
   * What a client at `fromOffset` is missing.
   *
   * A client with **no** offset (a first connection) gets the whole retained
   * buffer. A client whose offset is older than the retained window gets the
   * whole buffer marked `truncated`, because the bytes it actually asked for
   * are gone and pretending otherwise would leave its screen wrong.
   */
  since(fromOffset: number | null): ScrollbackReplay {
    if (fromOffset === null || fromOffset < this.start) {
      return { data: this.all(), offset: this.end, truncated: fromOffset !== null };
    }
    if (fromOffset >= this.end) return { data: '', offset: this.end, truncated: false };

    // Walk the retained chunks and take everything from the requested offset.
    // Chunk boundaries are the only safe cut points, so a request landing in
    // the middle of one includes that chunk from its start — a few extra bytes
    // the terminal simply rewrites.
    let cursor = this.start;
    const parts: string[] = [];
    for (const chunk of this.chunks) {
      const size = Buffer.byteLength(chunk, 'utf-8');
      if (cursor + size > fromOffset) parts.push(chunk);
      cursor += size;
    }
    return { data: parts.join(''), offset: this.end, truncated: false };
  }

  clear(): void {
    this.chunks = [];
    this.bytes = 0;
    this.start = this.end;
  }
}
