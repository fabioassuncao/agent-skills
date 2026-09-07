import { describe, expect, it } from 'vitest';
import { MAX_SCROLLBACK_BYTES, Scrollback } from './scrollback.js';

/**
 * The scrollback ring, plus the sequence offsets §15 requires the upstream does
 * not have. The upstream replays its whole 1 MB buffer on every reconnect, and a
 * browser reconnects on `visibilitychange`, `focus` and `online`.
 */
describe('Scrollback', () => {
  it('keeps the upstream ring size', () => {
    expect(MAX_SCROLLBACK_BYTES).toBe(1024 * 1024);
  });

  it('accumulates output and reports the offset after it', () => {
    const scrollback = new Scrollback();
    expect(scrollback.offset).toBe(0);

    scrollback.append('hello');
    scrollback.append(' world');
    expect(scrollback.all()).toBe('hello world');
    expect(scrollback.offset).toBe(11);
    expect(scrollback.oldestOffset).toBe(0);
  });

  it('counts bytes, not characters', () => {
    const scrollback = new Scrollback();
    scrollback.append('café');
    expect(scrollback.offset).toBe(5);
  });

  it('ignores an empty chunk rather than recording a no-op', () => {
    const scrollback = new Scrollback();
    scrollback.append('');
    expect(scrollback.offset).toBe(0);
  });

  describe('eviction', () => {
    // Splitting a chunk risks cutting a multi-byte character or an escape
    // sequence in half, and a terminal handed half an escape sequence renders
    // garbage from there on.
    it('evicts whole chunks and advances the oldest offset', () => {
      const scrollback = new Scrollback(10);
      scrollback.append('aaaaa');
      scrollback.append('bbbbb');
      scrollback.append('ccccc');

      expect(scrollback.all()).toBe('bbbbbccccc');
      expect(scrollback.oldestOffset).toBe(5);
      expect(scrollback.offset).toBe(15);
      expect(scrollback.retainedBytes).toBe(10);
    });

    // Evicting the only chunk would leave nothing at all, which is worse than
    // holding one chunk over the limit.
    it('never evicts the last chunk, however large', () => {
      const scrollback = new Scrollback(10);
      scrollback.append('x'.repeat(50));
      expect(scrollback.all()).toHaveLength(50);
    });

    it('keeps offsets monotonic across eviction, so they are never reused', () => {
      const scrollback = new Scrollback(10);
      for (let index = 0; index < 10; index += 1) scrollback.append('aaaaa');
      expect(scrollback.offset).toBe(50);
      expect(scrollback.oldestOffset).toBe(40);
    });
  });

  describe('since', () => {
    it('gives a first-time viewer everything retained', () => {
      const scrollback = new Scrollback();
      scrollback.append('hello');
      expect(scrollback.since(null)).toEqual({ data: 'hello', offset: 5, truncated: false });
    });

    // The point of the whole mechanism: a reconnecting client gets the
    // difference, not the megabyte it already has.
    it('gives a returning viewer only what it is missing', () => {
      const scrollback = new Scrollback();
      scrollback.append('hello');
      scrollback.append(' world');

      expect(scrollback.since(5)).toEqual({ data: ' world', offset: 11, truncated: false });
    });

    it('gives nothing to a viewer that is already current', () => {
      const scrollback = new Scrollback();
      scrollback.append('hello');
      expect(scrollback.since(5)).toEqual({ data: '', offset: 5, truncated: false });
      // An offset past the end is a client ahead of the server, which can only
      // mean a restarted session. Nothing to send, and nothing to correct.
      expect(scrollback.since(99)).toEqual({ data: '', offset: 5, truncated: false });
    });

    // Pretending otherwise would leave the client's screen missing a section it
    // has no way to know about.
    it('marks a replay as truncated when the requested bytes are gone', () => {
      const scrollback = new Scrollback(10);
      scrollback.append('aaaaa');
      scrollback.append('bbbbb');
      scrollback.append('ccccc');

      const replay = scrollback.since(0);
      expect(replay.truncated).toBe(true);
      expect(replay.data).toBe('bbbbbccccc');
      expect(replay.offset).toBe(15);
    });

    // Chunk boundaries are the only safe cut points, so a request landing in the
    // middle of one includes that chunk whole — a few bytes the terminal simply
    // rewrites, against the risk of a severed escape sequence.
    it('rounds down to a chunk boundary rather than cutting one', () => {
      const scrollback = new Scrollback();
      scrollback.append('hello');
      scrollback.append(' world');
      expect(scrollback.since(8).data).toBe(' world');
    });

    it('does not mark a first connection as truncated', () => {
      const scrollback = new Scrollback(10);
      scrollback.append('aaaaa');
      scrollback.append('bbbbb');
      scrollback.append('ccccc');
      expect(scrollback.since(null).truncated).toBe(false);
    });
  });

  it('clears without reusing offsets, so a client cannot be silently rewound', () => {
    const scrollback = new Scrollback();
    scrollback.append('hello');
    scrollback.clear();

    expect(scrollback.all()).toBe('');
    expect(scrollback.offset).toBe(5);
    expect(scrollback.oldestOffset).toBe(5);
  });
});
